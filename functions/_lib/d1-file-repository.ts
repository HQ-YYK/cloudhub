import type { D1Database } from '@cloudflare/workers-types'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type NewDirectory,
  type NewPendingFile,
  type UploadRepository,
  type UploadSession,
} from './file-repository.ts'

function isActiveNameConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed: index ['"]?idx_files_active_name['"]?/iu.test(message)
}

export function createD1FileRepository(db: D1Database): FileRepository & UploadRepository {
  return {
    async listChildren(ownerId, parentId) {
      return db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE owner_id = ?
          AND parent_id IS ?
          AND deleted_at IS NULL
        ORDER BY kind DESC, name_key ASC, id ASC
      `).bind(ownerId, parentId).all<FileRecord>().then((result) => result.results)
    },

    async listVisibleChildren(ownerId, parentId) {
      return db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE owner_id = ?
          AND parent_id IS ?
          AND deleted_at IS NULL
          AND (kind = 'directory' OR storage_status = 'ready')
        ORDER BY kind DESC, name_key ASC, id ASC
      `).bind(ownerId, parentId).all<FileRecord>().then((result) => result.results)
    },

    async findDirectory(ownerId, id) {
      return db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
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
            size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
          ) VALUES (?, ?, ?, 'directory', ?, ?, NULL, NULL, NULL, ?, ?, NULL, 'ready')
        `).bind(
          input.id,
          input.ownerId,
          input.parentId,
          input.name,
          input.nameKey,
          input.createdAt,
          input.updatedAt,
        ).run()
      } catch (error) {
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }

      const created = await db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(input.id, input.ownerId).first<FileRecord>()
      if (!created) throw new Error('created_file_not_found')
      return created
    },

    async findFile(ownerId, id) {
      return db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
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
            size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
          ) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, NULL, 'pending')
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
        ).run()
      } catch (error) {
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }

      const created = await db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
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
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
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
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
      if (!deleted || deleted.deleted_at !== deletedAt) throw new Error('deleted_file_not_found')
      return deleted
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

    async createUploadSession(session: UploadSession) {
      await db.prepare(`
        INSERT INTO upload_sessions (
          file_id, owner_id, session_uri_ciphertext, session_uri_iv,
          total_bytes, received_bytes, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        session.file_id,
        session.owner_id,
        session.session_uri_ciphertext,
        session.session_uri_iv,
        session.total_bytes,
        session.received_bytes,
        session.created_at,
        session.updated_at,
        session.expires_at,
      ).run()
    },

    async findUploadSession(ownerId, fileId) {
      return db.prepare(`
        SELECT file_id, owner_id, session_uri_ciphertext, session_uri_iv,
               total_bytes, received_bytes, created_at, updated_at, expires_at
        FROM upload_sessions
        WHERE file_id = ?
          AND owner_id = ?
        LIMIT 1
      `).bind(fileId, ownerId).first<UploadSession>()
    },

    async updateUploadProgress(ownerId, fileId, from, to, updatedAt) {
      const result = await db.prepare(`
        UPDATE upload_sessions
        SET received_bytes = ?, updated_at = ?
        WHERE file_id = ?
          AND owner_id = ?
          AND received_bytes = ?
      `).bind(to, updatedAt, fileId, ownerId, from).run()
      return result.meta.changes === 1
    },

    async deleteUploadSession(ownerId, fileId) {
      await db.prepare(`
        DELETE FROM upload_sessions
        WHERE file_id = ?
          AND owner_id = ?
      `).bind(fileId, ownerId).run()
    },

    async updateCompletedFile(ownerId, fileId, objectKey, md5, updatedAt) {
      const result = await db.prepare(`
        UPDATE files
        SET object_key = ?, md5 = ?, storage_status = 'ready', updated_at = ?
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'file'
          AND storage_status = 'pending'
          AND deleted_at IS NULL
      `).bind(objectKey, md5, updatedAt, fileId, ownerId).run()
      if (result.meta.changes === 0) return null
      if (result.meta.changes !== 1) throw new Error('unexpected_file_complete_count')

      const completed = await db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(fileId, ownerId).first<FileRecord>()
      if (!completed || completed.storage_status !== 'ready') throw new Error('completed_file_not_found')
      return completed
    },

    async markFileFailed(ownerId, fileId, updatedAt) {
      const result = await db.prepare(`
        UPDATE files
        SET storage_status = 'failed', updated_at = ?
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'file'
          AND deleted_at IS NULL
      `).bind(updatedAt, fileId, ownerId).run()
      if (result.meta.changes === 0) return null

      const failed = await db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(fileId, ownerId).first<FileRecord>()
      if (!failed || failed.storage_status !== 'failed') throw new Error('failed_file_not_found')
      return failed
    },
  }
}
