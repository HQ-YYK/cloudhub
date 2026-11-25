import type { D1Database } from '@cloudflare/workers-types'
import type {
  NewShare,
  ShareFileInfo,
  ShareRecord,
  ShareRepository,
  ShareWithFileRecord,
} from './share-repository.ts'

const SHARE_COLUMNS = 'id, owner_id, file_id, token_hash, token_ciphertext, token_iv, expires_at, revoked_at, download_count, created_at'

const SHARE_WITH_FILE_COLUMNS = `
  s.id, s.owner_id, s.file_id, s.token_hash, s.token_ciphertext, s.token_iv,
  s.expires_at, s.revoked_at, s.download_count, s.created_at,
  f.name AS file_name, f.size_bytes AS file_size_bytes,
  f.mime_type AS file_mime_type, f.object_key AS file_object_key,
  f.deleted_at AS file_deleted_at, f.storage_status AS file_storage_status,
  f.kind AS file_kind, f.storage_account_id AS file_storage_account_id
`

export function createD1ShareRepository(db: D1Database): ShareRepository {
  return {
    async create(input: NewShare) {
      await db.prepare(`
        INSERT INTO shares (
          id, owner_id, file_id, token_hash, token_ciphertext, token_iv,
          expires_at, revoked_at, download_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)
      `).bind(
        input.id,
        input.ownerId,
        input.fileId,
        input.tokenHash,
        input.tokenCiphertext,
        input.tokenIv,
        input.expiresAt,
        input.createdAt,
      ).run()
      return {
        id: input.id,
        owner_id: input.ownerId,
        file_id: input.fileId,
        token_hash: input.tokenHash,
        token_ciphertext: input.tokenCiphertext,
        token_iv: input.tokenIv,
        expires_at: input.expiresAt,
        revoked_at: null,
        download_count: 0,
        created_at: input.createdAt,
      } satisfies ShareRecord
    },

    async findById(id, ownerId) {
      return db.prepare(`
        SELECT ${SHARE_COLUMNS}
        FROM shares
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(id, ownerId).first<ShareRecord>()
    },

    async findActiveByTokenHash(tokenHash, now) {
      return db.prepare(`
        SELECT ${SHARE_WITH_FILE_COLUMNS}
        FROM shares s
        INNER JOIN files f ON f.id = s.file_id AND f.owner_id = s.owner_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > ?)
          AND f.deleted_at IS NULL
          AND f.kind = 'file'
          AND f.storage_status = 'ready'
        LIMIT 1
      `).bind(tokenHash, now).first<ShareWithFileRecord>()
    },

    async findFileForShare(ownerId, fileId) {
      return db.prepare(`
        SELECT id, name, size_bytes, mime_type, object_key, deleted_at, storage_status, kind
        FROM files
        WHERE id = ? AND owner_id = ?
        LIMIT 1
      `).bind(fileId, ownerId).first<ShareFileInfo>()
    },

    async listByFile(ownerId, fileId, limit) {
      return db.prepare(`
        SELECT ${SHARE_WITH_FILE_COLUMNS}
        FROM shares s
        INNER JOIN files f ON f.id = s.file_id AND f.owner_id = s.owner_id
        WHERE s.owner_id = ? AND s.file_id = ?
        ORDER BY s.created_at DESC
        LIMIT ?
      `).bind(ownerId, fileId, limit).all<ShareWithFileRecord>().then((result) => result.results)
    },

    async listByOwner(ownerId, limit) {
      return db.prepare(`
        SELECT ${SHARE_WITH_FILE_COLUMNS}
        FROM shares s
        INNER JOIN files f ON f.id = s.file_id AND f.owner_id = s.owner_id
        WHERE s.owner_id = ?
        ORDER BY s.created_at DESC
        LIMIT ?
      `).bind(ownerId, limit).all<ShareWithFileRecord>().then((result) => result.results)
    },

    async countActiveByFile(ownerId, fileId, now) {
      const row = await db.prepare(`
        SELECT COUNT(*) AS count
        FROM shares
        WHERE owner_id = ? AND file_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).bind(ownerId, fileId, now).first<{ count: number }>()
      return row?.count ?? 0
    },

    async revoke(id, ownerId, revokedAt) {
      await db.prepare(`
        UPDATE shares
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND owner_id = ?
      `).bind(revokedAt, id, ownerId).run()
    },

    async incrementDownloadCount(id) {
      await db.prepare('UPDATE shares SET download_count = download_count + 1 WHERE id = ?').bind(id).run()
    },
  }
}
