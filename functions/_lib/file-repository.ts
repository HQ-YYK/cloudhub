import type { FileStorageStatus } from './file-storage-state.ts'

export type FileKind = 'file' | 'directory'

export interface FileRecord {
  id: string
  owner_id: string
  parent_id: string | null
  kind: FileKind
  name: string
  name_key: string
  object_key: string | null
  size_bytes: number | null
  mime_type: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  storage_status: FileStorageStatus
  drive_folder_id?: string | null
  md5?: string | null
  purged_at?: string | null
}

export interface NewDirectory {
  id: string
  ownerId: string
  parentId: string | null
  name: string
  nameKey: string
  createdAt: string
  updatedAt: string
}

export interface NewPendingFile {
  id: string
  ownerId: string
  parentId: string | null
  name: string
  nameKey: string
  objectKey: string | null
  sizeBytes: number
  mimeType: string | null
  createdAt: string
  updatedAt: string
}

export interface UploadSession {
  file_id: string
  owner_id: string
  session_uri_ciphertext: string
  session_uri_iv: string
  total_bytes: number
  received_bytes: number
  created_at: string
  updated_at: string
  expires_at: string
}

export interface UploadRepository {
  findUserFolder(userId: string): Promise<{ id: string, username: string, drive_folder_id: string | null } | null>
  setUserFolderIfEmpty(userId: string, folderId: string): Promise<boolean>
  findDirectoryFolder(ownerId: string, id: string): Promise<{ id: string, name: string, parent_id: string | null, drive_folder_id: string | null } | null>
  setDirectoryFolderIfEmpty(ownerId: string, id: string, folderId: string): Promise<boolean>
  createUploadSession(session: UploadSession): Promise<void>
  findUploadSession(ownerId: string, fileId: string): Promise<UploadSession | null>
  updateUploadProgress(ownerId: string, fileId: string, from: number, to: number, updatedAt: string): Promise<boolean>
  deleteUploadSession(ownerId: string, fileId: string): Promise<void>
  updateCompletedFile(ownerId: string, fileId: string, objectKey: string, md5: string | null, updatedAt: string): Promise<FileRecord | null>
  markFileFailed(ownerId: string, fileId: string, updatedAt: string): Promise<FileRecord | null>
}

export class FileRepositoryConflictError extends Error {
  constructor() {
    super('file_repository_conflict')
    this.name = 'FileRepositoryConflictError'
  }
}

export interface FileRepository {
  listChildren(ownerId: string, parentId: string | null): Promise<FileRecord[]>
  listVisibleChildren(ownerId: string, parentId: string | null): Promise<FileRecord[]>
  findDirectory(ownerId: string, id: string): Promise<FileRecord | null>
  createDirectory(input: NewDirectory): Promise<FileRecord>
  findFile(ownerId: string, id: string): Promise<FileRecord | null>
  createPendingFile(input: NewPendingFile): Promise<FileRecord>
  updateFileStorageStatus(
    ownerId: string,
    id: string,
    from: FileStorageStatus,
    to: FileStorageStatus,
    updatedAt: string,
  ): Promise<FileRecord | null>
  softDeleteFile(
    ownerId: string,
    id: string,
    deletedAt: string,
    updatedAt: string,
  ): Promise<FileRecord | null>
}

export interface MoveRepository {
  findItem(ownerId: string, id: string): Promise<FileRecord | null>
  isDescendantOrSelf(ownerId: string, ancestorId: string, candidateId: string): Promise<boolean>
  updateNameAndParent(
    ownerId: string,
    id: string,
    name: string,
    nameKey: string,
    parentId: string | null,
    updatedAt: string,
  ): Promise<FileRecord | null>
}

export interface TrashItem {
  id: string
  owner_id: string
  parent_id: string | null
  kind: FileKind
  name: string
  name_key: string
  object_key: string | null
  size_bytes: number | null
  mime_type: string | null
  created_at: string
  updated_at: string
  deleted_at: string
  parent_name: string | null
}

export interface TrashRepository {
  listTrash(ownerId: string, cutoff: string): Promise<TrashItem[]>
  findTrashFile(ownerId: string, id: string, cutoff: string): Promise<TrashItem | null>
  hasActiveNameConflict(ownerId: string, parentId: string | null, nameKey: string): Promise<boolean>
  restoreFile(ownerId: string, id: string, updatedAt: string): Promise<FileRecord | null>
  deleteTrashedFile(ownerId: string, id: string): Promise<void>
  deleteExpiredTrash(ownerId: string, cutoff: string): Promise<number>
  listTrashObjectKeys(ownerId: string, cutoff: string, limit: number): Promise<Array<{ id: string, object_key: string }>>
  countTrash(ownerId: string, cutoff: string): Promise<number>
}
