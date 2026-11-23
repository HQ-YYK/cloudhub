import type { D1Database } from '@cloudflare/workers-types'
import type {
  OAuthState,
  StorageAccount,
  StorageAdminUser,
  StorageRepository,
} from './storage-repository.ts'

export function createD1StorageRepository(db: D1Database): StorageRepository {
  return {
    async getAccount() {
      return db.prepare(`
        SELECT id, google_email, refresh_token_ciphertext, refresh_token_iv,
          root_folder_id, connected_by, created_at, updated_at
        FROM storage_account
        WHERE id = 1
        LIMIT 1
      `).first<StorageAccount>()
    },

    async upsertAccount(account) {
      await db.prepare(`
        INSERT INTO storage_account (
          id, google_email, refresh_token_ciphertext, refresh_token_iv,
          root_folder_id, connected_by, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          google_email = excluded.google_email,
          refresh_token_ciphertext = excluded.refresh_token_ciphertext,
          refresh_token_iv = excluded.refresh_token_iv,
          root_folder_id = excluded.root_folder_id,
          connected_by = excluded.connected_by,
          updated_at = excluded.updated_at
      `).bind(
        account.google_email,
        account.refresh_token_ciphertext,
        account.refresh_token_iv,
        account.root_folder_id,
        account.connected_by,
        account.created_at,
        account.updated_at,
      ).run()
    },

    async deleteAccount() {
      await db.prepare('DELETE FROM storage_account WHERE id = 1').run()
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
