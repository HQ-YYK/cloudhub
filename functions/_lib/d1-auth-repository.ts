import type { D1Database } from '@cloudflare/workers-types'
import type {
  AuthRepository,
  LoginAttempt,
  NewSession,
  SessionUser,
  StoredUser,
} from './auth-repository.ts'

export function createD1AuthRepository(db: D1Database): AuthRepository {
  return {
    async findUser(username: string) {
      return db.prepare(`
        SELECT id, username, password_hash, password_salt, password_iterations, disabled
        FROM users
        WHERE username = ?
        LIMIT 1
      `).bind(username).first<StoredUser>()
    },

    async findSessionUser(tokenHash: string, now: string) {
      return db.prepare(`
        SELECT s.id AS session_id, u.id, u.username
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
          AND s.expires_at > ?
          AND u.disabled = 0
        LIMIT 1
      `).bind(tokenHash, now).first<SessionUser>()
    },

    async touchSession(sessionId: string, lastSeenAt: string) {
      await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
        .bind(lastSeenAt, sessionId).run()
    },

    async findLoginAttempt(username: string, ipHash: string) {
      return db.prepare(`
        SELECT failed_count, window_started_at, blocked_until
        FROM login_attempts
        WHERE username_key = ? AND ip_hash = ?
      `).bind(username.toLowerCase(), ipHash).first<LoginAttempt>()
    },

    async upsertLoginFailure(
      username: string,
      ipHash: string,
      failedCount: number,
      windowStartedAt: string,
      blockedUntil: string | null,
    ) {
      await db.prepare(`
        INSERT INTO login_attempts (username_key, ip_hash, failed_count, window_started_at, blocked_until)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(username_key, ip_hash) DO UPDATE SET
          failed_count = excluded.failed_count,
          window_started_at = excluded.window_started_at,
          blocked_until = excluded.blocked_until
      `).bind(
        username.toLowerCase(),
        ipHash,
        failedCount,
        windowStartedAt,
        blockedUntil,
      ).run()
    },

    async clearLoginFailures(username: string, ipHash: string) {
      await db.prepare('DELETE FROM login_attempts WHERE username_key = ? AND ip_hash = ?')
        .bind(username.toLowerCase(), ipHash).run()
    },

    async createSession(session: NewSession) {
      await db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        session.id,
        session.userId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
      ).run()
    },

    async deleteSessionByTokenHash(tokenHash: string) {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    },

    async revokeAllSessions(userId: string) {
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
    },
  }
}
