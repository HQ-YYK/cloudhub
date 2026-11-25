import { BlobStoreError } from './blob-store.ts'
import type { UploadRepository } from './file-repository.ts'
import type { StorageRepository } from './storage-repository.ts'

export interface DriveFolderClient {
  createFolder(name: string, parentId: string, accountId?: number): Promise<string>
  trash(id: string, accountId?: number): Promise<void>
}

async function settleFolder(
  client: DriveFolderClient,
  folderId: string,
  accountId: number,
  setIfEmpty: (folderId: string) => Promise<boolean>,
  readExisting: () => Promise<string | null>,
): Promise<string> {
  const updated = await setIfEmpty(folderId)
  if (updated) return folderId
  const existing = await readExisting()
  if (existing) {
    try {
      await client.trash(folderId, accountId)
    } catch {
      // Best-effort cleanup of the folder we lost the race to persist.
    }
    return existing
  }
  return folderId
}

export async function ensureUserFolder(
  client: DriveFolderClient,
  storageRepository: StorageRepository,
  accountId: number,
  userId: string,
): Promise<string> {
  const existing = await storageRepository.findUserFolder(accountId, userId)
  if (existing) return existing.folder_id

  const account = await storageRepository.getAccount(accountId)
  if (!account) throw new BlobStoreError('unavailable', 'storage_not_connected')

  const folderId = await client.createFolder(userId, account.root_folder_id, accountId)
  return settleFolder(
    client,
    folderId,
    accountId,
    (id) => storageRepository.setUserFolderIfEmpty(accountId, userId, id),
    async () => (await storageRepository.findUserFolder(accountId, userId))?.folder_id ?? null,
  )
}

// Legacy helper kept for move/rename of files uploaded before the flat layout.
export async function ensureDriveFolder(
  client: DriveFolderClient,
  storageRepository: StorageRepository,
  uploadRepository: UploadRepository,
  ownerId: string,
  directoryId: string | null,
): Promise<string> {
  if (directoryId === null) {
    const user = await uploadRepository.findUserFolder(ownerId)
    if (!user) throw new BlobStoreError('unavailable', 'storage_user_missing')
    if (user.drive_folder_id) return user.drive_folder_id

    const account = await storageRepository.getAccount(1)
    if (!account) throw new BlobStoreError('unavailable', 'storage_not_connected')

    const folderId = await client.createFolder(user.username, account.root_folder_id, 1)
    return settleFolder(
      client,
      folderId,
      1,
      (id) => uploadRepository.setUserFolderIfEmpty(ownerId, id),
      async () => (await uploadRepository.findUserFolder(ownerId))?.drive_folder_id ?? null,
    )
  }

  const directory = await uploadRepository.findDirectoryFolder(ownerId, directoryId)
  if (!directory) throw new Error('directory_folder_missing')
  if (directory.drive_folder_id) return directory.drive_folder_id

  const parentFolderId = await ensureDriveFolder(
    client,
    storageRepository,
    uploadRepository,
    ownerId,
    directory.parent_id,
  )
  const folderId = await client.createFolder(directory.name, parentFolderId, 1)
  return settleFolder(
    client,
    folderId,
    1,
    (id) => uploadRepository.setDirectoryFolderIfEmpty(ownerId, directoryId, id),
    async () => (await uploadRepository.findDirectoryFolder(ownerId, directoryId))?.drive_folder_id ?? null,
  )
}
