import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, SessionUser, StoredUser, UserSummary } from '../../_lib/auth-repository.ts'
import { hashPassword } from '../../_lib/auth.ts'
import { encryptSecret } from '../../_lib/secret-box.ts'
import { generateTotpSecret } from '../../_lib/totp.ts'
import type {
  LoginChallengeRecord,
  NewLoginChallenge,
  RecoveryCodeRecord,
  TotpRepository,
  TotpUser,
} from '../../_lib/totp-repository.ts'

export const userId = '11111111-1111-4111-8111-111111111111'
export const adminId = '22222222-2222-4222-8222-222222222222'
export const encryptionKey = Buffer.from('1'.repeat(32), 'ascii').toString('base64url')
export const authKey = Buffer.alloc(32, 2).toString('base64url')
export const wrongAuthKey = Buffer.alloc(32, 8).toString('base64url')
export const kdfSalt = Buffer.alloc(16, 1).toString('base64url')
export const sessionUser: SessionUser = {
  session_id: 'session-1',
  id: userId,
  username: 'alice',
  role: 'user',
  must_change_password: 0,
}
export const adminSessionUser: SessionUser = {
  session_id: 'admin-session',
  id: adminId,
  username: 'root',
  role: 'admin',
  must_change_password: 0,
}

export function verifyEnv() {
  return { DB: {} as D1Database, STORAGE_ENCRYPTION_KEY: encryptionKey }
}

export function originRequest(path: string, method = 'POST', body?: unknown, cookie?: string) {
  const bodyText = body === undefined ? undefined : JSON.stringify(body)
  return new Request(`https://cloudhub.test${path}`, {
    method,
    headers: {
      Origin: 'https://cloudhub.test',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bodyText === undefined ? {} : { 'Content-Length': String(bodyText.length) }),
    },
    body: bodyText,
  })
}

export function authRepository(options: {
  stored?: StoredUser | null
  sessionUser?: SessionUser | null
  users?: UserSummary[]
} = {}) {
  const stored = options.stored ?? null
  const authenticated = options.sessionUser ?? null
  const users = new Map((options.users ?? []).map((user) => [user.id, user]))
  const loginFailures: Array<[string, string]> = []
  const sessions: Array<{ userId: string }> = []
  const clearedFailures: Array<[string, string]> = []
  const revokedAll: string[] = []

  const repository: AuthRepository = {
    findUser: async (username) => (stored && stored.username === username ? stored : null),
    findSessionUser: async () => authenticated,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async (username, ipHash) => { loginFailures.push([username, ipHash]) },
    clearLoginFailures: async (username, ipHash) => { clearedFailures.push([username, ipHash]) },
    createSession: async (session) => { sessions.push({ userId: session.userId }) },
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async (id) => { revokedAll.push(id) },
    listUsers: async () => [...users.values()],
    findUserById: async (id) => users.get(id) ?? null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async () => undefined,
  }

  return {
    repository,
    get loginFailures() { return loginFailures },
    get sessions() { return sessions },
    get clearedFailures() { return clearedFailures },
    get revokedAll() { return revokedAll },
  }
}

export function totpRepository(initialUser: TotpUser | null = null) {
  let user = initialUser
  const challenges = new Map<string, LoginChallengeRecord>()
  const recoveryCodes: RecoveryCodeRecord[] = []
  const createdChallenges: NewLoginChallenge[] = []
  const deletedChallenges: string[] = []
  const incrementedChallenges: string[] = []
  const markedUsed: string[] = []
  const disabledUsers: string[] = []
  const deletedRecoveryUsers: string[] = []
  const lastSteps: Array<[string, number]> = []

  const repository: TotpRepository = {
    async findTotpUser(id) {
      return user && user.id === id ? user : null
    },
    async setPendingSecret(id, ciphertext, iv) {
      if (user && user.id === id) {
        user = { ...user, totp_pending_ciphertext: ciphertext, totp_pending_iv: iv }
      }
    },
    async enableTotp(id, ciphertext, iv) {
      if (user && user.id === id) {
        user = {
          ...user,
          totp_secret_ciphertext: ciphertext,
          totp_secret_iv: iv,
          totp_pending_ciphertext: null,
          totp_pending_iv: null,
          totp_enabled_at: '2030-01-01T00:00:00.000Z',
          totp_last_step: null,
        }
      }
    },
    async disableTotp(id) {
      disabledUsers.push(id)
      if (user && user.id === id) {
        user = {
          ...user,
          totp_secret_ciphertext: null,
          totp_secret_iv: null,
          totp_pending_ciphertext: null,
          totp_pending_iv: null,
          totp_enabled_at: null,
          totp_last_step: null,
        }
      }
    },
    async updateLastStep(id, step) {
      lastSteps.push([id, step])
      if (!user || user.id !== id) return false
      if (user.totp_last_step !== null && user.totp_last_step >= step) return false
      user = { ...user, totp_last_step: step }
      return true
    },
    async createRecoveryCodes(codes) {
      for (const code of codes) {
        recoveryCodes.push({
          id: code.id,
          user_id: code.userId,
          code_hash: code.codeHash,
          created_at: code.createdAt,
          used_at: null,
        })
      }
    },
    async deleteRecoveryCodes(id) {
      deletedRecoveryUsers.push(id)
      for (let index = recoveryCodes.length - 1; index >= 0; index -= 1) {
        if (recoveryCodes[index].user_id === id) recoveryCodes.splice(index, 1)
      }
    },
    async findRecoveryCode(id, codeHash) {
      return recoveryCodes.find((code) => code.user_id === id && code.code_hash === codeHash) ?? null
    },
    async markRecoveryCodeUsed(id, usedAt) {
      markedUsed.push(id)
      const code = recoveryCodes.find((candidate) => candidate.id === id)
      if (!code || code.used_at !== null) return false
      code.used_at = usedAt
      return true
    },
    async createLoginChallenge(input) {
      createdChallenges.push(input)
      challenges.set(input.tokenHash, {
        id: input.id,
        user_id: input.userId,
        token_hash: input.tokenHash,
        ip_hash: input.ipHash,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
        failed_count: 0,
      })
    },
    async findLoginChallengeByTokenHash(tokenHash, now) {
      const challenge = challenges.get(tokenHash)
      return challenge && challenge.expires_at > now ? challenge : null
    },
    async incrementLoginChallengeFailure(tokenHash) {
      incrementedChallenges.push(tokenHash)
      const challenge = challenges.get(tokenHash)
      if (challenge) challenge.failed_count += 1
    },
    async deleteLoginChallengeByTokenHash(tokenHash) {
      deletedChallenges.push(tokenHash)
      return challenges.delete(tokenHash)
    },
  }

  return {
    repository,
    challenges,
    recoveryCodes,
    createdChallenges,
    deletedChallenges,
    incrementedChallenges,
    markedUsed,
    disabledUsers,
    deletedRecoveryUsers,
    lastSteps,
    get user() { return user },
  }
}

export function plainUser(overrides: Partial<TotpUser> = {}): TotpUser {
  return {
    id: userId,
    username: 'alice',
    role: 'user',
    disabled: 0,
    must_change_password: 0,
    totp_secret_ciphertext: null,
    totp_secret_iv: null,
    totp_pending_ciphertext: null,
    totp_pending_iv: null,
    totp_enabled_at: null,
    totp_last_step: null,
    ...overrides,
  }
}

export async function enabledUser() {
  const secret = generateTotpSecret()
  const encrypted = await encryptSecret(secret, encryptionKey)
  const user = plainUser({
    totp_secret_ciphertext: encrypted.ciphertext,
    totp_secret_iv: encrypted.iv,
    totp_enabled_at: '2030-01-01T00:00:00.000Z',
  })
  return { secret, user }
}

export async function pendingUser() {
  const secret = generateTotpSecret()
  const encrypted = await encryptSecret(secret, encryptionKey)
  const user = plainUser({
    totp_pending_ciphertext: encrypted.ciphertext,
    totp_pending_iv: encrypted.iv,
  })
  return { secret, user }
}

export async function storedUser(key: string) {
  const hash = await hashPassword(key)
  const stored: StoredUser = {
    id: userId,
    username: 'alice',
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    disabled: 0,
    role: 'user',
    must_change_password: 0,
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: null,
    recovery_wrapped_key: null,
    keys_updated_at: null,
  }
  return stored
}

export function adminTarget(role: 'admin' | 'user' = 'user'): UserSummary {
  return {
    id: role === 'admin' ? adminId : userId,
    username: role === 'admin' ? 'root' : 'alice',
    role,
    disabled: 0,
    must_change_password: 0,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
  }
}
