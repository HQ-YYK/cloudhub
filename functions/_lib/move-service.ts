import { getAuthenticatedUser } from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'
import { BlobStoreError } from './blob-store.ts'
import { ensureDriveFolder, type DriveFolderClient } from './drive-folders.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type MoveRepository,
  type TrashRepository,
  type UploadRepository,
} from './file-repository.ts'
import {
  FileServiceError,
  normalizeFileName,
  publicFileRecord,
  validateFileId,
} from './file-service.ts'
import type { StorageRepository } from './storage-repository.ts'

export type MoveErrorCode =
  | 'unauthorized'
  | 'password_change_required'
  | 'invalid_request'
  | 'invalid_name'
  | 'not_found'
  | 'conflict'
  | 'invalid_move'
  | 'not_ready'
  | 'storage_unavailable'
  | 'storage_not_connected'

export class MoveServiceError extends Error {
  readonly code: MoveErrorCode

  constructor(code: MoveErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'MoveServiceError'
    this.code = code
  }
}

export interface MoveDriveClient extends DriveFolderClient {
  updateFile(id: string, patch: { name?: string; addParents?: string; removeParents?: string }): Promise<void>
  getParents(id: string): Promise<string[]>
}

export interface MovePatch {
  name?: unknown
  parentId?: unknown
}

export interface MoveServiceDeps {
  authRepository: AuthRepository
  fileRepository: MoveRepository & UploadRepository & TrashRepository
  storageRepository: StorageRepository
  driveClient: MoveDriveClient
  now?: () => Date
}

interface DriveChange {
  driveId: string
  nameChanged: boolean
  parentChanged: boolean
  newParentDriveId: string | null
  oldParentDriveId: string | null
}

function mapDriveError(error: unknown): MoveServiceError {
  if (error instanceof BlobStoreError && error.message === 'storage_not_connected') {
    return new MoveServiceError('storage_not_connected', { cause: error })
  }
  return new MoveServiceError('storage_unavailable', { cause: error })
}

export function createMoveService(deps: MoveServiceDeps) {
  const now = deps.now ?? (() => new Date())

  async function driveChange(
    ownerId: string,
    record: FileRecord,
    name: string,
    nameChanged: boolean,
    parentId: string | null,
    parentChanged: boolean,
  ): Promise<DriveChange | null> {
    let driveId: string | null
    if (record.kind === 'directory') {
      driveId = record.drive_folder_id ?? null
    } else {
      driveId = record.object_key ?? null
    }
    if (!driveId) {
      if (record.kind === 'directory') return null
      throw new MoveServiceError('storage_unavailable')
    }

    const change: DriveChange = {
      driveId,
      nameChanged,
      parentChanged,
      newParentDriveId: null,
      oldParentDriveId: null,
    }
    if (parentChanged) {
      change.newParentDriveId = await ensureDriveFolder(
        deps.driveClient,
        deps.storageRepository,
        deps.fileRepository,
        ownerId,
        parentId,
      )
      const parents = await deps.driveClient.getParents(driveId)
      change.oldParentDriveId = parents[0] ?? null
    }
    await deps.driveClient.updateFile(driveId, {
      ...(nameChanged ? { name } : {}),
      ...(parentChanged && change.newParentDriveId ? { addParents: change.newParentDriveId } : {}),
      ...(parentChanged && change.oldParentDriveId ? { removeParents: change.oldParentDriveId } : {}),
    })
    return change
  }

  async function applyDriveChange(
    ownerId: string,
    record: FileRecord,
    name: string,
    nameChanged: boolean,
    parentId: string | null,
    parentChanged: boolean,
  ): Promise<DriveChange | null> {
    try {
      return await driveChange(ownerId, record, name, nameChanged, parentId, parentChanged)
    } catch (error) {
      throw mapDriveError(error)
    }
  }

  async function rollbackDrive(record: FileRecord, change: DriveChange | null) {
    if (!change) return
    try {
      await deps.driveClient.updateFile(change.driveId, {
        ...(change.nameChanged ? { name: record.name } : {}),
        ...(change.parentChanged && change.oldParentDriveId ? { addParents: change.oldParentDriveId } : {}),
        ...(change.parentChanged && change.newParentDriveId ? { removeParents: change.newParentDriveId } : {}),
      })
    } catch {
      // Best-effort rollback; the D1 error we return matters more.
    }
  }

  async function patch(request: Request, fileId: string, body: MovePatch) {
    const user = await getAuthenticatedUser(deps.authRepository, request)
    if (!user) throw new MoveServiceError('unauthorized')
    if (user.mustChangePassword) throw new MoveServiceError('password_change_required')

    let validatedId: string
    try {
      validatedId = validateFileId(fileId)
    } catch {
      throw new MoveServiceError('invalid_request')
    }

    const record = await deps.fileRepository.findItem(user.id, validatedId)
    if (!record) throw new MoveServiceError('not_found')
    if (record.kind === 'file' && record.storage_status !== 'ready') {
      throw new MoveServiceError('not_ready')
    }

    let name = record.name
    let nameKey = record.name_key
    if (body.name !== undefined) {
      try {
        const normalized = normalizeFileName(body.name)
        name = normalized.name
        nameKey = normalized.nameKey
      } catch (error) {
        if (error instanceof FileServiceError && error.code === 'invalid_name') {
          throw new MoveServiceError('invalid_name')
        }
        throw error
      }
    }

    let parentId = record.parent_id
    if (body.parentId !== undefined) {
      if (body.parentId === null) {
        parentId = null
      } else if (typeof body.parentId === 'string') {
        try {
          validateFileId(body.parentId)
        } catch {
          throw new MoveServiceError('invalid_request')
        }
        parentId = body.parentId
      } else {
        throw new MoveServiceError('invalid_request')
      }
    }

    const nameChanged = name !== record.name
    const parentChanged = parentId !== record.parent_id

    if (!nameChanged && !parentChanged) {
      return publicFileRecord(record)
    }

    if (parentChanged && parentId !== null) {
      const parent = await deps.fileRepository.findItem(user.id, parentId)
      if (!parent || parent.kind !== 'directory') throw new MoveServiceError('not_found')
    }

    if (record.kind === 'directory' && parentChanged && parentId !== null) {
      const wouldCycle = await deps.fileRepository.isDescendantOrSelf(user.id, record.id, parentId)
      if (wouldCycle) throw new MoveServiceError('invalid_move')
    }

    const slotUnchanged = nameKey === record.name_key && parentId === record.parent_id
    if (!slotUnchanged) {
      const conflict = await deps.fileRepository.hasActiveNameConflict(user.id, parentId, nameKey)
      if (conflict) throw new MoveServiceError('conflict')
    }

    const change = await applyDriveChange(user.id, record, name, nameChanged, parentId, parentChanged)

    const updatedAt = now().toISOString()
    try {
      const updated = await deps.fileRepository.updateNameAndParent(
        user.id,
        record.id,
        name,
        nameKey,
        parentId,
        updatedAt,
      )
      if (!updated) throw new MoveServiceError('not_found')
      return publicFileRecord(updated)
    } catch (error) {
      if (error instanceof MoveServiceError) throw error
      await rollbackDrive(record, change)
      if (error instanceof FileRepositoryConflictError) {
        throw new MoveServiceError('conflict', { cause: error })
      }
      throw new MoveServiceError('storage_unavailable', { cause: error })
    }
  }

  return { patch }
}
