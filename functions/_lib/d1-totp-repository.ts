import type { D1Database } from '@cloudflare/workers-types'
import type {
  LoginChallengeRecord,
  NewLoginChallenge,
  NewRecoveryCode,
  RecoveryCodeRecord,
  TotpRepository,
  TotpUser,
} from './totp-repository.ts'

const TOTP_USER_COLUMNS = `
  id, username, role, disabled, must_change_password,
  totp_secret_ciphertext, totp_secret_iv,
  totp_pending_ciphertext, totp_pending_iv,
  totp_enabled_at, totp_last_step
`

export function createD1TotpRepository(db: D1Database): TotpRepository {
  return {
    async findTotpUser(userId: string) {
      return db.prepare(`
        SELECT ${TOTP_USER_COLUMNS}
        FROM users
        WHERE id = ?
        LIMIT 1
      `).bind(userId).first<TotpUser>()
    },

    async setPendingSecret(userId, ciphertext, iv, updatedAt) {
      await db.prepare(`
        UPDATE users
        SET totp_pending_ciphertext = ?, totp_pending_iv = ?, updated_at = ?
        WHERE id = ?
      `).bind(ciphertext, iv, updatedAt, userId).run()
    },

    async enableTotp(userId, ciphertext, iv, enabledAt) {
      await db.prepare(`
        UPDATE users
        SET totp_secret_ciphertext = ?, totp_secret_iv = ?,
            totp_pending_ciphertext = NULL, totp_pending_iv = NULL,
            totp_enabled_at = ?, totp_last_step = NULL, updated_at = ?
        WHERE id = ?
      `).bind(ciphertext, iv, enabledAt, enabledAt, userId).run()
    },

    async disableTotp(userId, updatedAt) {
      await db.prepare(`
        UPDATE users
        SET totp_secret_ciphertext = NULL, totp_secret_iv = NULL,
            totp_pending_ciphertext = NULL, totp_pending_iv = NULL,
            totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ?
        WHERE id = ?
      `).bind(updatedAt, userId).run()
    },

    async updateLastStep(userId, lastStep) {
      // Conditional update so two concurrent requests cannot both consume the same step.
      const result = await db.prepare(`
        UPDATE users SET totp_last_step = ?
        WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
      `).bind(lastStep, userId, lastStep).run()
      return result.meta.changes === 1
    },

    async createRecoveryCodes(codes: NewRecoveryCode[]) {
      const statements = codes.map((code) => db.prepare(`
        INSERT INTO totp_recovery_codes (id, user_id, code_hash, created_at, used_at)
        VALUES (?, ?, ?, ?, NULL)
      `).bind(code.id, code.userId, code.codeHash, code.createdAt))
      await db.batch(statements)
    },

    async deleteRecoveryCodes(userId) {
      await db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').bind(userId).run()
    },

    async findRecoveryCode(userId, codeHash) {
      return db.prepare(`
        SELECT id, user_id, code_hash, created_at, used_at
        FROM totp_recovery_codes
        WHERE user_id = ? AND code_hash = ?
        LIMIT 1
      `).bind(userId, codeHash).first<RecoveryCodeRecord>()
    },

    async markRecoveryCodeUsed(id, usedAt) {
      const result = await db.prepare('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .bind(usedAt, id).run()
      return result.meta.changes === 1
    },

    async createLoginChallenge(input: NewLoginChallenge) {
      await db.prepare(`
        INSERT INTO login_challenges (id, user_id, token_hash, ip_hash, created_at, expires_at, failed_count)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).bind(
        input.id,
        input.userId,
        input.tokenHash,
        input.ipHash,
        input.createdAt,
        input.expiresAt,
      ).run()
    },

    async findLoginChallengeByTokenHash(tokenHash, now) {
      return db.prepare(`
        SELECT id, user_id, token_hash, ip_hash, created_at, expires_at, failed_count
        FROM login_challenges
        WHERE token_hash = ? AND expires_at > ?
        LIMIT 1
      `).bind(tokenHash, now).first<LoginChallengeRecord>()
    },

    async incrementLoginChallengeFailure(tokenHash) {
      await db.prepare('UPDATE login_challenges SET failed_count = failed_count + 1 WHERE token_hash = ?')
        .bind(tokenHash).run()
    },

    async deleteLoginChallengeByTokenHash(tokenHash) {
      const result = await db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(tokenHash).run()
      return result.meta.changes === 1
    },
  }
}
