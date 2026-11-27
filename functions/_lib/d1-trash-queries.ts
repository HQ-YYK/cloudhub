import type { D1Database } from '@cloudflare/workers-types'
import { FILE_RECORD_COLUMNS } from './e2ee-files.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type TrashItem,
  type TrashRepository,
} from './file-repository.ts'
import { isActiveNameConflict } from './d1-conflicts.ts'

export function createD1TrashQueries(db: D1Database): TrashRepository {
  return {
    async listTrash(ownerId, cutoff) {
      return db.prepare(`
        SELECT f.id, f.owner_id, f.parent_id, f.kind, f.name, f.name_key, f.object_key,
               f.size_bytes, f.mime_type, f.created_at, f.updated_at, f.deleted_at,
               f.storage_account_id, f.enc, f.wrapped_key,
               parent.name AS parent_name,
               CASE WHEN f.kind = 'directory' THEN (
                 SELECT COUNT(*)
                 FROM files c
                 WHERE c.owner_id = f.owner_id
                   AND c.deleted_at = f.deleted_at
                   AND c.id <> f.id
               ) ELSE NULL END AS item_count
        FROM files f
        LEFT JOIN files parent
          ON parent.id = f.parent_id AND parent.owner_id = f.owner_id
        WHERE f.owner_id = ?
          AND f.deleted_at IS NOT NULL
          AND f.purged_at IS NULL
          AND f.deleted_at > ?
          AND (
            f.parent_id IS NULL
            OR parent.id IS NULL
            OR parent.deleted_at IS NULL
            OR parent.deleted_at <> f.deleted_at
          )
        ORDER BY f.deleted_at DESC
        LIMIT 500
      `).bind(ownerId, cutoff).all<TrashItem>().then((result) => result.results)
    },

    async findTrashFile(ownerId, id, cutoff) {
      return db.prepare(`
        SELECT f.id, f.owner_id, f.parent_id, f.kind, f.name, f.name_key, f.object_key,
               f.size_bytes, f.mime_type, f.created_at, f.updated_at, f.deleted_at,
               f.storage_account_id, f.enc, f.wrapped_key,
               parent.name AS parent_name,
               CASE WHEN f.kind = 'directory' THEN (
                 SELECT COUNT(*)
                 FROM files c
                 WHERE c.owner_id = f.owner_id
                   AND c.deleted_at = f.deleted_at
                   AND c.id <> f.id
               ) ELSE NULL END AS item_count
        FROM files f
        LEFT JOIN files parent
          ON parent.id = f.parent_id AND parent.owner_id = f.owner_id
        WHERE f.id = ?
          AND f.owner_id = ?
          AND f.deleted_at IS NOT NULL
          AND f.purged_at IS NULL
          AND f.deleted_at > ?
        LIMIT 1
      `).bind(id, ownerId, cutoff).first<TrashItem>()
    },

    async hasActiveNameConflict(ownerId, parentId, nameKey) {
      const row = await db.prepare(`
        SELECT 1 AS one
        FROM files
        WHERE owner_id = ?
          AND COALESCE(parent_id, '') = ?
          AND name_key = ?
          AND deleted_at IS NULL
          AND (kind = 'directory' OR storage_status IN ('pending', 'ready', 'deleting'))
        LIMIT 1
      `).bind(ownerId, parentId ?? '', nameKey).first<{ one: number }>()
      return row !== null
    },

    async restoreFile(ownerId, id, updatedAt) {
      let result
      try {
        result = await db.prepare(`
          UPDATE files
          SET deleted_at = NULL, storage_status = 'ready', updated_at = ?
          WHERE id = ?
            AND owner_id = ?
            AND deleted_at IS NOT NULL
            AND purged_at IS NULL
        `).bind(updatedAt, id, ownerId).run()
      } catch (error) {
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }
      if (result.meta.changes === 0) return null
      if (result.meta.changes !== 1) throw new Error('unexpected_file_restore_count')

      const restored = await db.prepare(`
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
      if (!restored || restored.deleted_at !== null || restored.storage_status !== 'ready') {
        throw new Error('restored_file_not_found')
      }
      return restored
    },

    // Shares and upload sessions go with the row via ON DELETE CASCADE.
    async deleteTrashedFile(ownerId, id) {
      await db.prepare(`
        DELETE FROM files
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'file'
          AND deleted_at IS NOT NULL
      `).bind(id, ownerId).run()
    },

    // Google empties the Drive trash after 30 days, so expired rows point at nothing.
    async deleteExpiredTrash(ownerId, cutoff) {
      await db.prepare(`
        UPDATE files
        SET parent_id = NULL
        WHERE owner_id = ?
          AND parent_id IS NOT NULL
          AND deleted_at IS NOT NULL
          AND deleted_at <= ?
      `).bind(ownerId, cutoff).run()

      // Keep expired files whose Drive object still exists; the trash service deletes them first.
      const result = await db.prepare(`
        DELETE FROM files
        WHERE owner_id = ?
          AND deleted_at IS NOT NULL
          AND deleted_at <= ?
          AND NOT (kind = 'file' AND object_key IS NOT NULL AND storage_status <> 'deleting')
      `).bind(ownerId, cutoff).run()
      return result.meta.changes ?? 0
    },

    async listTrashObjectKeys(ownerId, cutoff, limit) {
      return db.prepare(`
        SELECT id, object_key, storage_account_id
        FROM files
        WHERE owner_id = ?
          AND kind = 'file'
          AND deleted_at IS NOT NULL
          AND purged_at IS NULL
          AND deleted_at > ?
        ORDER BY deleted_at ASC
        LIMIT ?
      `).bind(ownerId, cutoff, limit).all<{ id: string, object_key: string | null, storage_account_id: number | null }>().then((result) => result.results)
    },

    async countTrash(ownerId, cutoff) {
      const row = await db.prepare(`
        SELECT COUNT(*) AS count
        FROM files
        WHERE owner_id = ?
          AND kind = 'file'
          AND deleted_at IS NOT NULL
          AND purged_at IS NULL
          AND deleted_at > ?
      `).bind(ownerId, cutoff).first<{ count: number }>()
      return row?.count ?? 0
    },
  }
}
