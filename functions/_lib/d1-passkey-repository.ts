import type { D1Database } from '@cloudflare/workers-types'
import type {
  NewPasskeyCredential,
  NewWebauthnChallenge,
  PasskeyCredential,
  PasskeyListItem,
  PasskeyLoginCredential,
  PasskeyRepository,
  WebauthnChallenge,
} from './passkey-repository.ts'

const PASSKEY_COLUMNS = `
  id, user_id, public_key, algorithm, sign_count, name, transports,
  prf_wrapped_master_key, created_at, last_used_at
`

export function createD1PasskeyRepository(db: D1Database): PasskeyRepository {
  return {
    async listPasskeys(userId) {
      const result = await db.prepare(`
        SELECT id, name, created_at, last_used_at, transports,
               (prf_wrapped_master_key IS NOT NULL) AS prf
        FROM passkey_credentials
        WHERE user_id = ?
        ORDER BY created_at
      `).bind(userId).all<PasskeyListItem>()
      return result.results
    },

    async countPasskeys(userId) {
      const row = await db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?')
        .bind(userId).first<{ count: number }>()
      return row?.count ?? 0
    },

    async findPasskeyById(id) {
      return db.prepare(`
        SELECT ${PASSKEY_COLUMNS}
        FROM passkey_credentials
        WHERE id = ?
        LIMIT 1
      `).bind(id).first<PasskeyCredential>()
    },

    async findPasskeyForLogin(credentialId) {
      return db.prepare(`
        SELECT p.id, p.user_id, p.public_key, p.algorithm, p.sign_count,
               p.prf_wrapped_master_key,
               u.username, u.role, u.disabled, u.must_change_password, u.wrapped_master_key
        FROM passkey_credentials p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.id = ?
        LIMIT 1
      `).bind(credentialId).first<PasskeyLoginCredential>()
    },

    async createPasskey(input: NewPasskeyCredential) {
      try {
        await db.prepare(`
          INSERT INTO passkey_credentials (
            id, user_id, public_key, algorithm, sign_count, name, transports,
            prf_wrapped_master_key, created_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
        `).bind(
          input.id,
          input.userId,
          input.publicKey,
          input.algorithm,
          input.signCount,
          input.name,
          input.transports,
          input.createdAt,
        ).run()
      } catch (error) {
        const details = String(error)
        if (details.includes('UNIQUE') || details.includes('unique')) return false
        throw error
      }
      return true
    },

    async updatePasskeyName(userId, id, name) {
      const result = await db.prepare('UPDATE passkey_credentials SET name = ? WHERE id = ? AND user_id = ?')
        .bind(name, id, userId).run()
      return result.meta.changes === 1
    },

    async setPrfWrappedKey(userId, id, prfWrappedKey) {
      const result = await db.prepare(`
        UPDATE passkey_credentials
        SET prf_wrapped_master_key = ?
        WHERE id = ? AND user_id = ? AND prf_wrapped_master_key IS NULL
      `).bind(prfWrappedKey, id, userId).run()
      return result.meta.changes === 1
    },

    async deletePasskey(userId, id) {
      const result = await db.prepare('DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?')
        .bind(id, userId).run()
      return result.meta.changes === 1
    },

    async deletePasskeysByUser(userId) {
      await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(userId).run()
    },

    async clearPrfWrappedKeys(userId) {
      await db.prepare('UPDATE passkey_credentials SET prf_wrapped_master_key = NULL WHERE user_id = ?')
        .bind(userId).run()
    },

    async updatePasskeyUsage(id, signCount, lastUsedAt) {
      await db.prepare('UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?')
        .bind(signCount, lastUsedAt, id).run()
    },

    async createWebauthnChallenge(input: NewWebauthnChallenge) {
      await db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(input.createdAt).run()
      await db.prepare(`
        INSERT INTO webauthn_challenges (id, user_id, purpose, challenge_hash, ip_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.id,
        input.userId,
        input.purpose,
        input.challengeHash,
        input.ipHash,
        input.createdAt,
        input.expiresAt,
      ).run()
    },

    async findWebauthnChallenge(challengeHash, now) {
      return db.prepare(`
        SELECT id, user_id, purpose, challenge_hash, ip_hash, created_at, expires_at
        FROM webauthn_challenges
        WHERE challenge_hash = ? AND expires_at > ?
        LIMIT 1
      `).bind(challengeHash, now).first<WebauthnChallenge>()
    },

    async consumeWebauthnChallenge(challengeHash, now) {
      const result = await db.prepare(`
        DELETE FROM webauthn_challenges WHERE challenge_hash = ? AND expires_at > ?
      `).bind(challengeHash, now).run()
      return result.meta.changes === 1
    },
  }
}
