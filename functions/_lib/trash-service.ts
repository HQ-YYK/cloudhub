import { getAuthenticatedUser } from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'
import { BlobStoreError } from './blob-store.ts'
import {
  FileRepositoryConflictError,
  type TrashItem,
  type TrashRepository,
  type TrashTreeRepository,
} from './file-repository.ts'
import { publicFileRecord, validateFileId } from './file-service.ts'

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const TRASH_CLEAR_BATCH_SIZE = 40
// Smaller than the clear batch so opening the trash stays fast.
const EXPIRED_PURGE_BATCH_SIZE = 20

export type TrashErrorCode =
  | 'unauthorized'
  | 'password_change_required'
  | 'not_found'
  | 'conflict'
  | 'purged'
  | 'storage_unavailable'

export class TrashServiceError extends Error {
  readonly code: TrashErrorCode

  constructor(code: TrashErrorCode, options?: { cause?: unknown }) {
    super(code, { cause: options?.cause })
    this.name = 'TrashServiceError'
    this.code = code
  }
}

export interface TrashDriveClient {
  untrash(id: string, accountId?: number): Promise<void>
  deletePermanently(id: string, accountId?: number): Promise<void>
  trash(id: string, accountId?: number): Promise<void>
}

interface AuthenticatedUser {
  id: string
  mustChangePassword: boolean
}

export interface TrashServiceDeps {
  authRepository: AuthRepository
  trashRepository: TrashRepository & TrashTreeRepository
  driveClient: TrashDriveClient
  now?: () => Date
}

export function createTrashService(deps: TrashServiceDeps) {
  const now = deps.now ?? (() => new Date())

  async function authenticated(request: Request): Promise<AuthenticatedUser> {
    const user = await getAuthenticatedUser(deps.authRepository, request)
    if (!user) throw new TrashServiceError('unauthorized')
    if (user.mustChangePassword) throw new TrashServiceError('password_change_required')
    return user
  }

  function cutoffIso() {
    return new Date(now().getTime() - TRASH_RETENTION_MS).toISOString()
  }

  async function markPurged(ownerId: string, fileId: string) {
    await deps.trashRepository.deleteTrashedFile(ownerId, fileId)
  }

  async function list(request: Request) {
    const user = await authenticated(request)
    const cutoff = cutoffIso()
    const expiredLive = await deps.trashRepository.listExpiredLiveObjectKeys(
      user.id,
      cutoff,
      EXPIRED_PURGE_BATCH_SIZE,
    )
    for (const record of expiredLive) {
      try {
        await deps.driveClient.deletePermanently(record.object_key, record.storage_account_id ?? 1)
      } catch (error) {
        if (!(error instanceof BlobStoreError && error.code === 'not_found')) break
      }
      await markPurged(user.id, record.id)
    }
    await deps.trashRepository.deleteExpiredTrash(user.id, cutoff)
    const items = await deps.trashRepository.listTrash(user.id, cutoff)
    return {
      items: items.map((item) => ({
        ...publicFileRecord(item),
        deleted_at: item.deleted_at,
        expires_at: new Date(new Date(item.deleted_at).getTime() + TRASH_RETENTION_MS).toISOString(),
        parent_name: item.parent_name,
        ...(item.kind === 'directory' ? { item_count: item.item_count ?? 0 } : {}),
      })),
    }
  }

  async function restoreFileItem(user: AuthenticatedUser, fileId: string, item: TrashItem) {
    if (item.object_key === null) throw new TrashServiceError('not_found')

    if (await deps.trashRepository.hasActiveNameConflict(user.id, item.parent_id, item.name_key)) {
      throw new TrashServiceError('conflict')
    }

    try {
      await deps.driveClient.untrash(item.object_key, item.storage_account_id ?? 1)
    } catch (error) {
      if (error instanceof BlobStoreError && error.code === 'not_found') {
        await markPurged(user.id, fileId)
        throw new TrashServiceError('purged')
      }
      throw new TrashServiceError('storage_unavailable', { cause: error })
    }

    let restored
    try {
      restored = await deps.trashRepository.restoreFile(user.id, fileId, now().toISOString())
    } catch (error) {
      if (error instanceof FileRepositoryConflictError) {
        try {
          await deps.driveClient.trash(item.object_key, item.storage_account_id ?? 1)
        } catch {
          // Best-effort re-trash after a concurrent same-name restore race.
        }
        throw new TrashServiceError('conflict')
      }
      throw error
    }
    if (!restored) throw new TrashServiceError('not_found')
    return { item: publicFileRecord(restored) }
  }

  async function restoreFolderItem(user: AuthenticatedUser, item: TrashItem) {
    const parentId = item.parent_id
    const activeParent = parentId
      ? await deps.trashRepository.findActiveDirectory(user.id, parentId)
      : null
    const targetParentId = parentId && activeParent ? parentId : null

    if (await deps.trashRepository.hasActiveNameConflict(user.id, targetParentId, item.name_key)) {
      throw new TrashServiceError('conflict')
    }

    let restored
    try {
      restored = await deps.trashRepository.restoreFolderTree(
        user.id,
        item.id,
        item.deleted_at,
        targetParentId,
        now().toISOString(),
      )
    } catch (error) {
      if (error instanceof FileRepositoryConflictError) {
        throw new TrashServiceError('conflict')
      }
      throw error
    }
    if (!restored) throw new TrashServiceError('not_found')
    return { item: publicFileRecord(restored) }
  }

  async function restore(request: Request, fileId: string) {
    const user = await authenticated(request)
    try {
      validateFileId(fileId)
    } catch {
      throw new TrashServiceError('not_found')
    }

    const item = await deps.trashRepository.findTrashFile(user.id, fileId, cutoffIso())
    if (!item) throw new TrashServiceError('not_found')

    if (item.kind === 'directory') return restoreFolderItem(user, item)
    return restoreFileItem(user, fileId, item)
  }

  async function purgeFolder(user: AuthenticatedUser, item: TrashItem) {
    const batch = await deps.trashRepository.listBatchObjectKeys(
      user.id,
      item.deleted_at,
      TRASH_CLEAR_BATCH_SIZE,
    )

    let purged = 0
    for (const record of batch) {
      try {
        await deps.driveClient.deletePermanently(record.object_key, record.storage_account_id ?? 1)
      } catch (error) {
        if (!(error instanceof BlobStoreError && error.code === 'not_found')) break
      }
      await markPurged(user.id, record.id)
      purged += 1
    }

    const remaining = await deps.trashRepository.countBatchFiles(user.id, item.deleted_at)
    if (remaining === 0) {
      await deps.trashRepository.deleteTrashedBatch(user.id, item.deleted_at)
    }
    return { purged, remaining }
  }

  async function purgeOne(request: Request, fileId: string) {
    const user = await authenticated(request)
    try {
      validateFileId(fileId)
    } catch {
      throw new TrashServiceError('not_found')
    }

    const item = await deps.trashRepository.findTrashFile(user.id, fileId, cutoffIso())
    if (!item) throw new TrashServiceError('not_found')

    if (item.kind === 'directory') return purgeFolder(user, item)

    if (item.object_key === null) throw new TrashServiceError('not_found')

    try {
      await deps.driveClient.deletePermanently(item.object_key, item.storage_account_id ?? 1)
    } catch (error) {
      if (!(error instanceof BlobStoreError && error.code === 'not_found')) {
        throw new TrashServiceError('storage_unavailable', { cause: error })
      }
    }

    await markPurged(user.id, fileId)
    return { purged: true }
  }

  async function clear(request: Request) {
    const user = await authenticated(request)
    const cutoff = cutoffIso()
    const batch = await deps.trashRepository.listTrashObjectKeys(
      user.id,
      cutoff,
      TRASH_CLEAR_BATCH_SIZE,
    )

    let purged = 0
    for (const record of batch) {
      try {
        await deps.driveClient.deletePermanently(record.object_key, record.storage_account_id ?? 1)
      } catch (error) {
        if (!(error instanceof BlobStoreError && error.code === 'not_found')) {
          break
        }
      }
      await markPurged(user.id, record.id)
      purged += 1
    }

    await deps.trashRepository.purgeEmptyTrashFolders(user.id, cutoff)
    const remaining = await deps.trashRepository.countTrash(user.id, cutoff)
    return { purged, remaining }
  }

  return { list, restore, purgeOne, clear }
}
