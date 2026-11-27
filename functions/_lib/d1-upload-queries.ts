import type { D1Database } from '@cloudflare/workers-types'
import { FILE_RECORD_COLUMNS } from './e2ee-files.ts'
import type { FileRecord, UploadRepository, UploadSession } from './file-repository.ts'

export type D1UploadQueries = Pick<UploadRepository,
  | 'createUploadSession'
  | 'findUploadSession'
  | 'updateUploadProgress'
  | 'deleteUploadSession'
  | 'updateCompletedFile'
  | 'markFileFailed'
>

export function createD1UploadQueries(db: D1Database): D1UploadQueries {
  return {
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
        SELECT ${FILE_RECORD_COLUMNS}
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
        SELECT ${FILE_RECORD_COLUMNS}
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(fileId, ownerId).first<FileRecord>()
      if (!failed || failed.storage_status !== 'failed') throw new Error('failed_file_not_found')
      return failed
    },
  }
}
