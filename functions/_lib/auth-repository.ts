export interface StoredUser {
  id: string
  username: string
  password_hash: string
  password_salt: string
  password_iterations: number
  disabled: number
  role: 'admin' | 'user'
  must_change_password: number
  kdf_salt: string | null
  kdf_iterations: number | null
  wrapped_master_key: string | null
  recovery_wrapped_key: string | null
  keys_updated_at: string | null
}

export interface SessionUser {
  session_id: string
  id: string
  username: string
  role: 'admin' | 'user'
  must_change_password: number
  kdf_salt?: string | null
  wrapped_master_key?: string | null
  last_seen_at?: string | null
}

export interface UserSummary {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: number
  must_change_password: number
  created_at: string
  updated_at: string
}

export interface CreateUserInput {
  id: string
  username: string
  passwordHash: string
  passwordSalt: string
  passwordIterations: number
  kdfSalt: string
  kdfIterations: number
  role: 'admin' | 'user'
  mustChangePassword: number
  createdAt: string
}

export class AuthRepositoryConflictError extends Error {
  constructor(message = 'auth_repository_conflict') {
    super(message)
    this.name = 'AuthRepositoryConflictError'
  }
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
  recordLoginFailure(
    username: string,
    ipHash: string,
    now: string,
    windowMs: number,
    maxFailures: number,
    blockMs: number,
  ): Promise<void>
  clearLoginFailures(username: string, ipHash: string): Promise<void>
  createSession(session: NewSession): Promise<void>
  deleteSessionByTokenHash(tokenHash: string): Promise<void>
  revokeAllSessions(userId: string): Promise<void>
  listUsers(): Promise<UserSummary[]>
  findUserById(id: string): Promise<UserSummary | null>
  createUser(input: CreateUserInput): Promise<UserSummary>
  updatePassword(userId: string, hash: string, salt: string, iterations: number, kdfSalt: string, kdfIterations: number, mustChangePassword: number, updatedAt: string): Promise<void>
  setDisabled(userId: string, disabled: number, updatedAt: string): Promise<void>
  revokeOtherSessions(userId: string, keepSessionId: string): Promise<void>
}
