export interface StoredUser {
  id: string
  username: string
  password_hash: string
  password_salt: string
  password_iterations: number
  disabled: number
}

export interface SessionUser {
  session_id: string
  id: string
  username: string
}

export interface LoginAttempt {
  failed_count: number
  window_started_at: string
  blocked_until: string | null
}

export interface NewSession {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
}

export interface AuthRepository {
  findUser(username: string): Promise<StoredUser | null>
  findSessionUser(tokenHash: string, now: string): Promise<SessionUser | null>
  touchSession(sessionId: string, lastSeenAt: string): Promise<void>
  findLoginAttempt(username: string, ipHash: string): Promise<LoginAttempt | null>
  upsertLoginFailure(
    username: string,
    ipHash: string,
    failedCount: number,
    windowStartedAt: string,
    blockedUntil: string | null,
  ): Promise<void>
  clearLoginFailures(username: string, ipHash: string): Promise<void>
  createSession(session: NewSession): Promise<void>
  deleteSessionByTokenHash(tokenHash: string): Promise<void>
  revokeAllSessions(userId: string): Promise<void>
}
