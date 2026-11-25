import type { D1Database } from '@cloudflare/workers-types'
import type {
  NewStorageAccount,
  OAuthState,
  StorageAccount,
  StorageAccountStatus,
  StorageAccountWithStats,
  StorageAdminUser,
  StorageRepository,
} from './storage-repository.ts'

const ACCOUNT_COLUMNS = `
  id, google_email, refresh_token_ciphertext, refresh_token_iv,
  root_folder_id, connected_by, status, quota_total, quota_used,
  quota_checked_at, created_at, updated_at
`

export function createD1StorageRepository(db: D1Database): StorageRepository {
  return {
    async getAccount(accountId) {
      return db.prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM storage_accounts
        WHERE id = ?
        LIMIT 1
      `).bind(accountId).first<StorageAccount>()
    },

    async listAccounts() {
      return db.prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM storage_accounts
        ORDER BY id ASC
      `).all<StorageAccount>().then((result) => result.results)
    },

    async listAccountsWithStats() {
      return db.prepare(`
        SELECT ${ACCOUNT_COLUMNS},
          COALESCE(stats.file_count, 0) AS file_count,
          COALESCE(stats.bytes_stored, 0) AS bytes_stored
        FROM storage_accounts a
        LEFT JOIN (
          SELECT storage_account_id,
                 COUNT(*) AS file_count,
                 COALESCE(SUM(size_bytes), 0) AS bytes_stored
          FROM files
          WHERE storage_account_id IS NOT NULL
          GROUP BY storage_account_id
        ) stats ON stats.storage_account_id = a.id
        ORDER BY a.id ASC
      `).all<StorageAccountWithStats>().then((result) => result.results)
    },

    async countAccounts() {
      const row = await db.prepare('SELECT COUNT(*) AS count FROM storage_accounts').first<{ count: number }>()
      return row?.count ?? 0
    },

    async findAccountByEmail(email) {
      return db.prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM storage_accounts
        WHERE google_email = ? COLLATE NOCASE
        LIMIT 1
      `).bind(email).first<StorageAccount>()
    },

    async createAccount(input: NewStorageAccount) {
      const result = await db.prepare(`
        INSERT INTO storage_accounts (
          google_email, refresh_token_ciphertext, refresh_token_iv,
          root_folder_id, connected_by, status, quota_total, quota_used,
          quota_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)
      `).bind(
        input.googleEmail,
        input.refreshTokenCiphertext,
        input.refreshTokenIv,
        input.rootFolderId,
        input.connectedBy,
        input.createdAt,
        input.updatedAt,
      ).run()
      const account = await db.prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM storage_accounts
        WHERE id = ?
        LIMIT 1
      `).bind(result.meta.last_row_id).first<StorageAccount>()
      if (!account) throw new Error('created_storage_account_not_found')
      return account
    },

    async updateAccountTokens(accountId, googleEmail, refreshTokenCiphertext, refreshTokenIv, connectedBy, status, updatedAt) {
      const result = await db.prepare(`
        UPDATE storage_accounts
        SET google_email = ?,
            refresh_token_ciphertext = ?,
            refresh_token_iv = ?,
            connected_by = ?,
            status = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(
        googleEmail,
        refreshTokenCiphertext,
        refreshTokenIv,
        connectedBy,
        status,
        updatedAt,
        accountId,
      ).run()
      if (result.meta.changes === 0) return null
      return db.prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM storage_accounts
        WHERE id = ?
        LIMIT 1
      `).bind(accountId).first<StorageAccount>()
    },

    async setAccountStatus(accountId, status: StorageAccountStatus, updatedAt) {
      const result = await db.prepare(`
        UPDATE storage_accounts
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).bind(status, updatedAt, accountId).run()
      if (result.meta.changes === 0) return null
      return db.prepare(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM storage_accounts
        WHERE id = ?
        LIMIT 1
      `).bind(accountId).first<StorageAccount>()
    },

    async setAccountReauth(accountId, updatedAt) {
      await db.prepare(`
        UPDATE storage_accounts
        SET status = 'reauth', updated_at = ?
        WHERE id = ?
      `).bind(updatedAt, accountId).run()
    },

    async setAccountQuota(accountId, quotaTotal, quotaUsed, checkedAt) {
      await db.prepare(`
        UPDATE storage_accounts
        SET quota_total = ?, quota_used = ?, quota_checked_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(quotaTotal, quotaUsed, checkedAt, checkedAt, accountId).run()
    },

    async deleteAccount(accountId) {
      await db.prepare('DELETE FROM storage_accounts WHERE id = ?').bind(accountId).run()
    },

    async countFilesByAccount(accountId) {
      const row = await db.prepare(`
        SELECT COUNT(*) AS count
        FROM files
        WHERE storage_account_id = ?
      `).bind(accountId).first<{ count: number }>()
      return row?.count ?? 0
    },

    async pendingBytesByAccount(accountId) {
      const row = await db.prepare(`
        SELECT COALESCE(SUM(size_bytes), 0) AS bytes
        FROM files
        WHERE storage_account_id = ?
          AND kind = 'file'
          AND storage_status = 'pending'
          AND deleted_at IS NULL
      `).bind(accountId).first<{ bytes: number }>()
      return row?.bytes ?? 0
    },

    async findUserFolder(accountId, userId) {
      return db.prepare(`
        SELECT user_id, folder_id
        FROM storage_user_folders
        WHERE account_id = ? AND user_id = ?
        LIMIT 1
      `).bind(accountId, userId).first<{ user_id: string; folder_id: string }>()
    },

    async setUserFolderIfEmpty(accountId, userId, folderId) {
      const result = await db.prepare(`
        INSERT INTO storage_user_folders (account_id, user_id, folder_id)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id, user_id) DO NOTHING
      `).bind(accountId, userId, folderId).run()
      return result.meta.changes === 1
    },

    async deleteExpiredOAuthStates(now) {
      await db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now).run()
    },

    async createOAuthState(stateHash, userId, expiresAt) {
      await db.prepare(`
        INSERT INTO oauth_states (state_hash, user_id, expires_at)
        VALUES (?, ?, ?)
      `).bind(stateHash, userId, expiresAt).run()
    },

    async consumeOAuthState(stateHash, now) {
      return db.prepare(`
        DELETE FROM oauth_states
        WHERE state_hash = ? AND expires_at > ?
        RETURNING state_hash, user_id, expires_at
      `).bind(stateHash, now).first<OAuthState>()
    },

    async findAdminUserById(userId) {
      return db.prepare(`
        SELECT id, role, disabled, must_change_password
        FROM users
        WHERE id = ? AND role = 'admin' AND disabled = 0
          AND must_change_password = 0
        LIMIT 1
      `).bind(userId).first<StorageAdminUser>()
    },
  }
}
