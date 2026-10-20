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

    async recordLoginFailure(
      username: string,
      ipHash: string,
      now: string,
      windowMs: number,
      maxFailures: number,
      blockMs: number,
    ) {
      await db.prepare(`
        INSERT INTO login_attempts (username_key, ip_hash, failed_count, window_started_at, blocked_until)
        VALUES (?, ?, 1, ?, NULL)
        ON CONFLICT(username_key, ip_hash) DO UPDATE SET
          failed_count = CASE
            WHEN ROUND((julianday(excluded.window_started_at) - julianday(login_attempts.window_started_at))
              * 86400000) < ? THEN login_attempts.failed_count + 1
            ELSE 1
          END,
          window_started_at = CASE
            WHEN ROUND((julianday(excluded.window_started_at) - julianday(login_attempts.window_started_at))
              * 86400000) < ? THEN login_attempts.window_started_at
            ELSE excluded.window_started_at
          END,
          blocked_until = CASE
            WHEN (
              CASE
                WHEN ROUND((julianday(excluded.window_started_at) - julianday(login_attempts.window_started_at))
                  * 86400000) < ? THEN login_attempts.failed_count + 1
                ELSE 1
              END
            ) >= ? THEN strftime(
              '%Y-%m-%dT%H:%M:%fZ',
              excluded.window_started_at,
              '+' || (? / 1000.0) || ' seconds'
            )
            ELSE NULL
          END
      `).bind(
        username.toLowerCase(),
        ipHash,
        now,
        windowMs,
        windowMs,
        windowMs,
        maxFailures,
        blockMs,
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
