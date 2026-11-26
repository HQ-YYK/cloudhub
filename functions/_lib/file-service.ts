import { getAuthenticatedUser } from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'
import { BlobStoreError, type BlobStore } from './blob-store.ts'
import {
  assertFileStorageTransition,
  type FileStorageStatus,
} from './file-storage-state.ts'
import {
  FileRepositoryConflictError,
  FileRepositoryIdConflictError,
  type FileRecord,
  type FileRepository,
  type FolderDeleteRepository,
} from './file-repository.ts'
import type { ServerTiming } from './server-timing.ts'

export const FILE_NAME_MAX_LENGTH = 255

export class FileServiceError extends Error {
  readonly code:
    | 'unauthorized'
    | 'invalid_name'
    | 'invalid_parent'
    | 'resource_not_found'
    | 'invalid_storage_transition'
    | 'invalid_mime'
    | 'too_large'
    | 'invalid_body'
    | 'upload_failed'
    | 'cleanup_failed'
    | 'delete_failed'
    | 'conflict'
    | 'id_conflict'
    | 'password_change_required'
    | 'folder_too_large'
    | 'folder_busy'

  constructor(code: FileServiceError['code'], options?: ErrorOptions) {
    super(code, options)
    this.name = 'FileServiceError'
    this.code = code
  }
}

export function normalizeFileName(value: unknown) {
  if (typeof value !== 'string') throw new FileServiceError('invalid_name')
  const name = value.normalize('NFC').trim()
  const hasControlCharacter = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  if (
    name.length === 0
    || name.length > FILE_NAME_MAX_LENGTH
    || hasControlCharacter
    || name.includes('/')
    || name.includes('\\')
  ) {
    throw new FileServiceError('invalid_name')
  }
  return {
    name,
    nameKey: name.toLocaleLowerCase('en-US'),
  }
}

export function validateFileId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new FileServiceError('invalid_parent')
  }
  return value
}

export async function listFiles(
  authRepository: AuthRepository,
  fileRepository: FileRepository,
  request: Request,
  parentId: string | null,
  timing?: ServerTiming,
) {
  const user = await getAuthenticatedUser(authRepository, request)
  timing?.mark('auth')
  if (!user) throw new FileServiceError('unauthorized')
  if (user.mustChangePassword) throw new FileServiceError('password_change_required')
  if (parentId !== null) {
    validateFileId(parentId)
    const parent = await fileRepository.findDirectory(user.id, parentId)
    if (!parent) throw new FileServiceError('invalid_parent')
  }
  const items = await fileRepository.listVisibleChildren(user.id, parentId)
  timing?.mark('db')
  return items
}

export async function createDirectory(
  authRepository: AuthRepository,
  fileRepository: FileRepository,
  request: Request,
  parentId: string | null,
  id: string,
  encName: string,
  nameKey: string,
  timing?: ServerTiming,
) {
  const user = await getAuthenticatedUser(authRepository, request)
  timing?.mark('auth')
  if (!user) throw new FileServiceError('unauthorized')
  if (user.mustChangePassword) throw new FileServiceError('password_change_required')
  if (parentId !== null) {
    validateFileId(parentId)
    const parent = await fileRepository.findDirectory(user.id, parentId)
    if (!parent) throw new FileServiceError('invalid_parent')
  }

  try {
    const item = await fileRepository.createDirectory({
      id,
      ownerId: user.id,
      parentId,
      name: encName,
      nameKey,
      enc: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    timing?.mark('db')
    return item
  } catch (error) {
    if (error instanceof FileRepositoryIdConflictError) throw new FileServiceError('id_conflict')
    if (error instanceof FileRepositoryConflictError) throw new FileServiceError('conflict')
    throw error
  }
}

export async function transitionFileStorage(
  authRepository: AuthRepository,
  fileRepository: FileRepository,
  request: Request,
  fileId: string,
  from: FileStorageStatus,
  to: FileStorageStatus,
  updatedAt = new Date().toISOString(),
) {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new FileServiceError('unauthorized')
  if (user.mustChangePassword) throw new FileServiceError('password_change_required')
  validateFileId(fileId)
  try {
    assertFileStorageTransition(from, to)
  } catch (error) {
    throw new FileServiceError('invalid_storage_transition', { cause: error })
  }
  const updated = await fileRepository.updateFileStorageStatus(user.id, fileId, from, to, updatedAt)
  if (!updated) throw new FileServiceError('resource_not_found')
  return updated
}

async function deleteFileCore(
  fileRepository: FileRepository,
  createBlobStore: () => BlobStore,
  userId: string,
  fileId: string,
  now: string,
) {
  const record = await fileRepository.findFile(userId, fileId)
  if (!record || record.kind !== 'file' || record.deleted_at !== null) {
    throw new FileServiceError('resource_not_found')
  }
  if (record.storage_status === 'deleting') throw new FileServiceError('conflict')
  if (record.object_key === null) throw new FileServiceError('delete_failed')
  const blobStore = createBlobStore()

  try {
    assertFileStorageTransition(record.storage_status, 'deleting')
  } catch (error) {
    throw new FileServiceError('invalid_storage_transition', { cause: error })
  }

  const deleting = await fileRepository.updateFileStorageStatus(
    userId,
    fileId,
    record.storage_status,
    'deleting',
    now,
  )
  if (!deleting) throw new FileServiceError('conflict')
  const objectKey = deleting.object_key ?? record.object_key

  try {
    await blobStore.delete(objectKey)
  } catch (error) {
    if (!(error instanceof BlobStoreError && error.code === 'not_found')) {
      try {
        await fileRepository.updateFileStorageStatus(userId, fileId, 'deleting', 'failed', now)
      } catch {
        // Keep deleting when the recovery transition is uncertain.
      }
      throw new FileServiceError('delete_failed', { cause: error })
    }
  }

  try {
    const deleted = await fileRepository.softDeleteFile(userId, fileId, now, now)
    if (!deleted) throw new FileServiceError('delete_failed')
    return deleted
  } catch (error) {
    if (error instanceof FileServiceError) throw error
    throw new FileServiceError('delete_failed', { cause: error })
  }
}

export async function deleteFile(
  authRepository: AuthRepository,
  fileRepository: FileRepository,
  createBlobStore: () => BlobStore,
  request: Request,
  fileId: string,
  now = new Date().toISOString(),
) {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new FileServiceError('unauthorized')
  if (user.mustChangePassword) throw new FileServiceError('password_change_required')
  validateFileId(fileId)
  return deleteFileCore(fileRepository, createBlobStore, user.id, fileId, now)
}

const FOLDER_DELETE_LIMIT = 5000

export async function deleteItem(
  authRepository: AuthRepository,
  fileRepository: FileRepository & FolderDeleteRepository,
  createBlobStore: () => BlobStore,
  request: Request,
  fileId: string,
  now = new Date().toISOString(),
): Promise<{ deleted: true, count?: number }> {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new FileServiceError('unauthorized')
  if (user.mustChangePassword) throw new FileServiceError('password_change_required')
  validateFileId(fileId)

  const directory = await fileRepository.findDirectory(user.id, fileId)
  if (!directory) {
    await deleteFileCore(fileRepository, createBlobStore, user.id, fileId, now)
    return { deleted: true }
  }

  const descendants = await fileRepository.countFolderDescendants(user.id, fileId)
  if (descendants > FOLDER_DELETE_LIMIT) throw new FileServiceError('folder_too_large')
  if (await fileRepository.hasPendingDescendant(user.id, fileId)) throw new FileServiceError('folder_busy')

  const count = await fileRepository.softDeleteFolderTree(user.id, fileId, now, now)
  if (count === 0) throw new FileServiceError('resource_not_found')
  return { deleted: true, count }
}

export function publicFileRecord(
  record: Pick<FileRecord, 'id' | 'parent_id' | 'kind' | 'name' | 'size_bytes' | 'mime_type' | 'created_at' | 'updated_at' | 'enc' | 'wrapped_key'>,
) {
  return {
    id: record.id,
    parent_id: record.parent_id,
    kind: record.kind,
    name: record.name,
    size_bytes: record.size_bytes,
    mime_type: record.mime_type,
    created_at: record.created_at,
    updated_at: record.updated_at,
    enc: record.enc ?? 0,
    wrappedKey: record.wrapped_key ?? null,
  }
}
