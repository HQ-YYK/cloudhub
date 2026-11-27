import type { D1Database } from '@cloudflare/workers-types'
import { FILE_RECORD_COLUMNS } from './e2ee-files.ts'
import {
  FileRepositoryConflictError,
  FileRepositoryIdConflictError,
  type FileRecord,
  type FileRepository,
  type MoveRepository,
  type NewDirectory,
  type NewPendingFile,
  type TrashRepository,
  type UploadRepository,
} from './file-repository.ts'
import { isActiveNameConflict, isIdConflict } from './d1-conflicts.ts'
import { createD1TrashQueries } from './d1-trash-queries.ts'
import { createD1UploadQueries } from './d1-upload-queries.ts'

export function createD1FileRepository(db: D1Database): FileRepository & UploadRepository & TrashRepository & MoveRepository {
  return {
    async listChildren(ownerId, parentId) {
      return db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE owner_id = ?
          AND parent_id IS ?
          AND deleted_at IS NULL
        ORDER BY id ASC
      `).bind(ownerId, parentId).all<FileRecord>().then((result) => result.results)
    },

    async listVisibleChildren(ownerId, parentId) {
      return db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE owner_id = ?
          AND parent_id IS ?
          AND deleted_at IS NULL
          AND (kind = 'directory' OR storage_status = 'ready')
        ORDER BY id ASC
      `).bind(ownerId, parentId).all<FileRecord>().then((result) => result.results)
    },

    async findDirectory(ownerId, id) {
      return db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'directory'
          AND deleted_at IS NULL
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
    },

    async createDirectory(input: NewDirectory) {
      try {
        await db.prepare(`
          INSERT INTO files (
            id, owner_id, parent_id, kind, name, name_key, object_key,
            size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status,
            enc, wrapped_key
          ) VALUES (?, ?, ?, 'directory', ?, ?, NULL, NULL, NULL, ?, ?, NULL, 'ready', ?, NULL)
        `).bind(
          input.id,
          input.ownerId,
          input.parentId,
          input.name,
          input.nameKey,
          input.createdAt,
          input.updatedAt,
          input.enc,
        ).run()
      } catch (error) {
        if (isIdConflict(error)) throw new FileRepositoryIdConflictError()
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }

      const created = await db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(input.id, input.ownerId).first<FileRecord>()
      if (!created) throw new Error('created_file_not_found')
      return created
    },

    async findFile(ownerId, id) {
      return db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'file'
          AND deleted_at IS NULL
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
    },

    async createPendingFile(input: NewPendingFile) {
      try {
        await db.prepare(`
          INSERT INTO files (
            id, owner_id, parent_id, kind, name, name_key, object_key,
            size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status,
            storage_account_id, enc, wrapped_key
          ) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)
        `).bind(
          input.id,
          input.ownerId,
          input.parentId,
          input.name,
          input.nameKey,
          input.objectKey,
          input.sizeBytes,
          input.mimeType,
          input.createdAt,
          input.updatedAt,
          input.storageAccountId,
          input.enc,
          input.wrappedKey,
        ).run()
      } catch (error) {
        if (isIdConflict(error)) throw new FileRepositoryIdConflictError()
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }

      const created = await db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(input.id, input.ownerId).first<FileRecord>()
      if (!created) throw new Error('created_file_not_found')
      return created
    },

    async updateFileStorageStatus(ownerId, id, from, to, updatedAt) {
      const result = await db.prepare(`
        UPDATE files
        SET storage_status = ?, updated_at = ?
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'file'
          AND storage_status = ?
          AND deleted_at IS NULL
      `).bind(to, updatedAt, id, ownerId, from).run()
      if (result.meta.changes === 0) return null
      if (result.meta.changes !== 1) throw new Error('unexpected_file_storage_update_count')

      const updated = await db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
      if (!updated || updated.storage_status !== to) throw new Error('updated_file_not_found')
      return updated
    },

    async softDeleteFile(ownerId, id, deletedAt, updatedAt) {
      const result = await db.prepare(`
        UPDATE files
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'file'
          AND storage_status = 'deleting'
          AND deleted_at IS NULL
      `).bind(deletedAt, updatedAt, id, ownerId).run()
      if (result.meta.changes === 0) return null
      if (result.meta.changes !== 1) throw new Error('unexpected_file_soft_delete_count')

      const deleted = await db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
      if (!deleted || deleted.deleted_at !== deletedAt) throw new Error('deleted_file_not_found')
      return deleted
    },

    async findItem(ownerId, id) {
      return db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ?
          AND owner_id = ?
          AND deleted_at IS NULL
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
    },

    async isDescendantOrSelf(ownerId, ancestorId, candidateId) {
      const row = await db.prepare(`
        WITH RECURSIVE ancestors(id, parent_id) AS (
          SELECT id, parent_id
          FROM files
          WHERE id = ?
            AND owner_id = ?
            AND deleted_at IS NULL
          UNION ALL
          SELECT files.id, files.parent_id
          FROM files
          JOIN ancestors ON files.id = ancestors.parent_id
          WHERE files.owner_id = ?
            AND files.deleted_at IS NULL
        )
        SELECT 1 AS one
        FROM ancestors
        WHERE id = ?
        LIMIT 1
      `).bind(candidateId, ownerId, ownerId, ancestorId).first<{ one: number }>()
      return row !== null
    },

    async updateNameAndParent(ownerId, id, name, nameKey, parentId, enc, wrappedKey, updatedAt) {
      let result
      try {
        result = await db.prepare(`
          UPDATE files
          SET name = ?, name_key = ?, parent_id = ?, enc = ?, wrapped_key = ?, updated_at = ?
          WHERE id = ?
            AND owner_id = ?
            AND deleted_at IS NULL
        `).bind(name, nameKey, parentId, enc, wrappedKey, updatedAt, id, ownerId).run()
      } catch (error) {
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }
      if (result.meta.changes === 0) return null
      if (result.meta.changes !== 1) throw new Error('unexpected_file_move_update_count')

      const updated = await db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
      if (!updated || updated.deleted_at !== null) throw new Error('updated_file_not_found')
      return updated
    },

    async findUserFolder(userId) {
      return db.prepare(`
        SELECT id, username, drive_folder_id
        FROM users
        WHERE id = ?
        LIMIT 1
      `).bind(userId).first<{ id: string, username: string, drive_folder_id: string | null }>()
    },

    async setUserFolderIfEmpty(userId, folderId) {
      const result = await db.prepare(`
        UPDATE users
        SET drive_folder_id = ?
        WHERE id = ?
          AND drive_folder_id IS NULL
      `).bind(folderId, userId).run()
      return result.meta.changes === 1
    },

    async findDirectoryFolder(ownerId, id) {
      return db.prepare(`
        SELECT id, name, parent_id, drive_folder_id
        FROM files
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'directory'
          AND deleted_at IS NULL
        LIMIT 1
      `).bind(id, ownerId).first<{ id: string, name: string, parent_id: string | null, drive_folder_id: string | null }>()
    },

    async setDirectoryFolderIfEmpty(ownerId, id, folderId) {
      const result = await db.prepare(`
        UPDATE files
        SET drive_folder_id = ?
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'directory'
          AND drive_folder_id IS NULL
      `).bind(folderId, id, ownerId).run()
      return result.meta.changes === 1
    },

    ...createD1TrashQueries(db),
    ...createD1UploadQueries(db),
  }
}
