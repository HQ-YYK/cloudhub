import type { D1Database } from '@cloudflare/workers-types'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type NewDirectory,
  type NewPendingFile,
} from './file-repository.ts'

function isActiveNameConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed: index ['"]?idx_files_active_name['"]?/iu.test(message)
}

export function createD1FileRepository(db: D1Database): FileRepository {
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
  }
}
