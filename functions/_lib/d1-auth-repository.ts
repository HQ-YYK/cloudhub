import type { D1Database } from '@cloudflare/workers-types'
import {
  AuthRepositoryConflictError,
} from './auth-repository.ts'
import type {
  AuthRepository,
  LoginAttempt,
  NewSession,
  SessionUser,
  StoredUser,
  UserSummary,
} from './auth-repository.ts'

export function createD1AuthRepository(db: D1Database): AuthRepository {
  return {
    async findUser(username: string) {
      return db.prepare(`
        SELECT id, username, password_hash, password_salt, password_iterations, disabled, role, must_change_password
        FROM users
        WHERE username = ?
        LIMIT 1
      `).bind(username).first<StoredUser>()
    },

    async findSessionUser(tokenHash: string, now: string) {
      return db.prepare(`
        SELECT s.id AS session_id, u.id, u.username, u.role, u.must_change_password
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

    async listUsers() {
      const result = await db.prepare(`
        SELECT id, username, role, disabled, must_change_password, created_at, updated_at
        FROM users
        ORDER BY created_at
      `).all<UserSummary>()
      return result.results
    },

    async findUserById(id: string) {
      return db.prepare(`
        SELECT id, username, role, disabled, must_change_password, created_at, updated_at
        FROM users
        WHERE id = ?
        LIMIT 1
      `).bind(id).first<UserSummary>()
    },

    async createUser(input) {
      try {
        await db.prepare(`
          INSERT INTO users (
            id, username, password_hash, password_salt, password_iterations,
            created_at, updated_at, disabled, role, must_change_password
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).bind(
          input.id,
          input.username,
          input.passwordHash,
          input.passwordSalt,
          input.passwordIterations,
          input.createdAt,
          input.createdAt,
          input.role,
          input.mustChangePassword,
        ).run()
      } catch (error) {
        const details = String(error)
        if (details.includes('UNIQUE') || details.includes('unique')) {
          throw new AuthRepositoryConflictError('username_taken')
        }
        throw error
      }
      const created = await db.prepare(`
        SELECT id, username, role, disabled, must_change_password, created_at, updated_at
        FROM users
        WHERE id = ?
        LIMIT 1
      `).bind(input.id).first<UserSummary>()
      if (!created) throw new Error('created_user_not_found')
      return created
    },

    async updatePassword(userId, hash, salt, iterations, mustChangePassword, updatedAt) {
      await db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, password_iterations = ?,
            must_change_password = ?, updated_at = ?
        WHERE id = ?
      `).bind(hash, salt, iterations, mustChangePassword, updatedAt, userId).run()
    },

    async setDisabled(userId, disabled, updatedAt) {
      await db.prepare(`
        UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?
      `).bind(disabled, updatedAt, userId).run()
    },

    async revokeOtherSessions(userId, keepSessionId) {
      await db.prepare(`
        DELETE FROM sessions WHERE user_id = ? AND id != ?
      `).bind(userId, keepSessionId).run()
    },
  }
}
