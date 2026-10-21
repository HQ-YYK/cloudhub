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
  objectKey: string
  mimeType: string | null
  createdAt: string
  updatedAt: string
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
}
