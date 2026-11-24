import { BlobStoreError } from './blob-store.ts'
import type { UploadRepository } from './file-repository.ts'
import type { StorageRepository } from './storage-repository.ts'

export interface DriveFolderClient {
  createFolder(name: string, parentId: string): Promise<string>
  trash(id: string): Promise<void>
}

async function settleFolder(
  client: DriveFolderClient,
  folderId: string,
  setIfEmpty: (folderId: string) => Promise<boolean>,
  readExisting: () => Promise<string | null>,
): Promise<string> {
  const updated = await setIfEmpty(folderId)
  if (updated) return folderId
  const existing = await readExisting()
  if (existing) {
    try {
      await client.trash(folderId)
    } catch {
      // Best-effort cleanup of the folder we lost the race to persist.
    }
    return existing
  }
  return folderId
}

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

    const account = await storageRepository.getAccount()
    if (!account) throw new BlobStoreError('unavailable', 'storage_not_connected')

    const folderId = await client.createFolder(user.username, account.root_folder_id)
    return settleFolder(
      client,
      folderId,
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
  const folderId = await client.createFolder(directory.name, parentFolderId)
  return settleFolder(
    client,
    folderId,
    (id) => uploadRepository.setDirectoryFolderIfEmpty(ownerId, directoryId, id),
    async () => (await uploadRepository.findDirectoryFolder(ownerId, directoryId))?.drive_folder_id ?? null,
  )
}
