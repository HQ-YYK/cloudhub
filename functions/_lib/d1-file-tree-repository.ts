import type { D1Database } from '@cloudflare/workers-types'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FolderDeleteRepository,
  type TrashTreeRepository,
} from './file-repository.ts'

function isActiveNameConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed: index ['"]?idx_files_active_name['"]?/iu.test(message)
}

export function createD1FileTreeRepository(db: D1Database): FolderDeleteRepository & TrashTreeRepository {
  return {
    async countFolderDescendants(ownerId, id) {
      const row = await db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id
          FROM files
          WHERE id = ?
            AND owner_id = ?
            AND kind = 'directory'
            AND deleted_at IS NULL
          UNION ALL
          SELECT files.id
          FROM files
          JOIN subtree ON files.parent_id = subtree.id
          WHERE files.owner_id = ?
            AND files.deleted_at IS NULL
        )
        SELECT COUNT(*) AS count
        FROM subtree
        WHERE id <> ?
      `).bind(id, ownerId, ownerId, id).first<{ count: number }>()
      return row?.count ?? 0
    },

    async hasPendingDescendant(ownerId, id) {
      const row = await db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id
          FROM files
          WHERE id = ?
            AND owner_id = ?
            AND kind = 'directory'
            AND deleted_at IS NULL
          UNION ALL
          SELECT files.id
          FROM files
          JOIN subtree ON files.parent_id = subtree.id
          WHERE files.owner_id = ?
            AND files.deleted_at IS NULL
        )
        SELECT 1 AS one
        FROM files
        WHERE owner_id = ?
          AND kind = 'file'
          AND storage_status = 'pending'
          AND id IN (SELECT id FROM subtree)
        LIMIT 1
      `).bind(id, ownerId, ownerId, ownerId).first<{ one: number }>()
      return row !== null
    },

    async softDeleteFolderTree(ownerId, id, deletedAt, updatedAt) {
      const result = await db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id
          FROM files
          WHERE id = ?
            AND owner_id = ?
            AND kind = 'directory'
            AND deleted_at IS NULL
          UNION ALL
          SELECT files.id
          FROM files
          JOIN subtree ON files.parent_id = subtree.id
          WHERE files.owner_id = ?
            AND files.deleted_at IS NULL
        )
        UPDATE files
        SET deleted_at = ?, updated_at = ?
        WHERE owner_id = ?
          AND deleted_at IS NULL
          AND id IN (SELECT id FROM subtree)
      `).bind(id, ownerId, ownerId, deletedAt, updatedAt, ownerId).run()
      return result.meta.changes ?? 0
    },

    async findActiveDirectory(ownerId, id) {
      return db.prepare(`
        SELECT id
        FROM files
        WHERE id = ?
          AND owner_id = ?
          AND kind = 'directory'
          AND deleted_at IS NULL
        LIMIT 1
      `).bind(id, ownerId).first<{ id: string }>()
    },

    async restoreFolderTree(ownerId, id, deletedAt, targetParentId, updatedAt) {
      let result
      try {
        result = await db.prepare(`
          UPDATE files
          SET deleted_at = NULL,
              updated_at = ?,
              parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END
          WHERE owner_id = ?
            AND deleted_at = ?
            AND purged_at IS NULL
            AND (kind = 'directory' OR storage_status <> 'deleting')
        `).bind(updatedAt, id, targetParentId, ownerId, deletedAt).run()
      } catch (error) {
        if (isActiveNameConflict(error)) throw new FileRepositoryConflictError()
        throw error
      }
      if (result.meta.changes === 0) return null

      const restored = await db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at, storage_status
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<FileRecord>()
      if (!restored || restored.deleted_at !== null) throw new Error('restored_folder_not_found')
      return restored
    },

    async deleteTrashedBatch(ownerId, deletedAt) {
      await db.prepare(`
        UPDATE files
        SET parent_id = NULL
        WHERE owner_id = ?
          AND parent_id IS NOT NULL
          AND (
            deleted_at = ?
            OR parent_id IN (
              SELECT id FROM files WHERE owner_id = ? AND deleted_at = ?
            )
          )
      `).bind(ownerId, deletedAt, ownerId, deletedAt).run()

      const result = await db.prepare(`
        DELETE FROM files
        WHERE owner_id = ?
          AND deleted_at = ?
      `).bind(ownerId, deletedAt).run()
      return result.meta.changes ?? 0
    },

    async listBatchObjectKeys(ownerId, deletedAt, limit) {
      return db.prepare(`
        SELECT id, object_key
        FROM files
        WHERE owner_id = ?
          AND kind = 'file'
          AND deleted_at = ?
          AND purged_at IS NULL
          AND object_key IS NOT NULL
        ORDER BY id ASC
        LIMIT ?
      `).bind(ownerId, deletedAt, limit).all<{ id: string, object_key: string }>().then((result) => result.results)
    },

    async countBatchFiles(ownerId, deletedAt) {
      const row = await db.prepare(`
        SELECT COUNT(*) AS count
        FROM files
        WHERE owner_id = ?
          AND kind = 'file'
          AND deleted_at = ?
          AND purged_at IS NULL
      `).bind(ownerId, deletedAt).first<{ count: number }>()
      return row?.count ?? 0
    },

    // Files trashed together with a folder were never moved to the Drive trash
    // (storage_status stays 'ready'/'failed'), so Google will not empty them for us.
    async listExpiredLiveObjectKeys(ownerId, cutoff, limit) {
      return db.prepare(`
        SELECT id, object_key
        FROM files
        WHERE owner_id = ?
          AND kind = 'file'
          AND deleted_at IS NOT NULL
          AND deleted_at <= ?
          AND storage_status <> 'deleting'
          AND object_key IS NOT NULL
        ORDER BY deleted_at ASC
        LIMIT ?
      `).bind(ownerId, cutoff, limit).all<{ id: string, object_key: string }>().then((result) => result.results)
    },

    async purgeEmptyTrashFolders(ownerId, cutoff) {
      await db.prepare(`
        UPDATE files
        SET parent_id = NULL
        WHERE owner_id = ?
          AND parent_id IS NOT NULL
          AND (
            deleted_at IN (
              SELECT d.deleted_at
              FROM files d
              WHERE d.owner_id = ?
                AND d.kind = 'directory'
                AND d.deleted_at IS NOT NULL
                AND d.purged_at IS NULL
                AND d.deleted_at > ?
                AND NOT EXISTS (
                  SELECT 1
                  FROM files f
                  WHERE f.owner_id = ?
                    AND f.deleted_at = d.deleted_at
                    AND f.kind = 'file'
                    AND f.purged_at IS NULL
                )
            )
            OR parent_id IN (
              SELECT id
              FROM files
              WHERE owner_id = ?
                AND deleted_at IN (
                  SELECT d.deleted_at
                  FROM files d
                  WHERE d.owner_id = ?
                    AND d.kind = 'directory'
                    AND d.deleted_at IS NOT NULL
                    AND d.purged_at IS NULL
                    AND d.deleted_at > ?
                    AND NOT EXISTS (
                      SELECT 1
                      FROM files f
                      WHERE f.owner_id = ?
                        AND f.deleted_at = d.deleted_at
                        AND f.kind = 'file'
                        AND f.purged_at IS NULL
                    )
                )
            )
          )
      `).bind(
        ownerId,
        ownerId,
        cutoff,
        ownerId,
        ownerId,
        ownerId,
        cutoff,
        ownerId,
      ).run()

      const result = await db.prepare(`
        DELETE FROM files
        WHERE owner_id = ?
          AND deleted_at IN (
            SELECT d.deleted_at
            FROM files d
            WHERE d.owner_id = ?
              AND d.kind = 'directory'
              AND d.deleted_at IS NOT NULL
              AND d.purged_at IS NULL
              AND d.deleted_at > ?
              AND NOT EXISTS (
                SELECT 1
                FROM files f
                WHERE f.owner_id = ?
                  AND f.deleted_at = d.deleted_at
                  AND f.kind = 'file'
                  AND f.purged_at IS NULL
              )
          )
      `).bind(ownerId, ownerId, cutoff, ownerId).run()
      return result.meta.changes ?? 0
    },
  }
}
