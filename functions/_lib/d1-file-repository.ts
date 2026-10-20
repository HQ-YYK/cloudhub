import type { D1Database } from '@cloudflare/workers-types'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type NewDirectory,
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
               size_bytes, mime_type, created_at, updated_at, deleted_at
        FROM files
        WHERE owner_id = ?
          AND parent_id IS ?
          AND deleted_at IS NULL
        ORDER BY kind DESC, name_key ASC, id ASC
      `).bind(ownerId, parentId).all<FileRecord>().then((result) => result.results)
    },

    async findDirectory(ownerId, id) {
      return db.prepare(`
        SELECT id, owner_id, parent_id, kind, name, name_key, object_key,
               size_bytes, mime_type, created_at, updated_at, deleted_at
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
            size_bytes, mime_type, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, 'directory', ?, ?, NULL, NULL, NULL, ?, ?, NULL)
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
               size_bytes, mime_type, created_at, updated_at, deleted_at
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(input.id, input.ownerId).first<FileRecord>()
      if (!created) throw new Error('created_file_not_found')
      return created
    },
  }
}
