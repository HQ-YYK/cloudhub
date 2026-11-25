import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, SessionUser, StoredUser, UserSummary } from '../../_lib/auth-repository.ts'
import { hashPassword, sha256 } from '../../_lib/auth.ts'
import { encryptSecret } from '../../_lib/secret-box.ts'
import {
  base32Decode,
  generateTotpSecret,
  otpauthUrl,
  TOTP_DIGITS,
  totpCode,
} from '../../_lib/totp.ts'
import type {
  LoginChallengeRecord,
  NewLoginChallenge,
  RecoveryCodeRecord,
  TotpRepository,
  TotpUser,
} from '../../_lib/totp-repository.ts'
import { createLoginHandler } from './login.ts'
import { createAdminTotpResetHandler } from '../admin/users/[id]/totp/reset.ts'
import { createTotpDisableHandler } from './totp/disable.ts'
import { createTotpEnableHandler } from './totp/enable.ts'
import { createTotpSetupHandler } from './totp/setup.ts'
import { createVerifyTotpHandler } from './totp/verify.ts'

const userId = '11111111-1111-4111-8111-111111111111'
const adminId = '22222222-2222-4222-8222-222222222222'
const encryptionKey = Buffer.from('1'.repeat(32), 'ascii').toString('base64url')
const sessionUser: SessionUser = {
  session_id: 'session-1',
  id: userId,
  username: 'alice',
  role: 'user',
  must_change_password: 0,
}
const adminSessionUser: SessionUser = {
  session_id: 'admin-session',
  id: adminId,
  username: 'root',
  role: 'admin',
  must_change_password: 0,
}

function verifyEnv() {
  return { DB: {} as D1Database, STORAGE_ENCRYPTION_KEY: encryptionKey }
}

function originRequest(path: string, method = 'POST', body?: unknown, cookie?: string) {
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

function authRepository(options: {
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

function totpRepository(initialUser: TotpUser | null = null) {
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

function plainUser(overrides: Partial<TotpUser> = {}): TotpUser {
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

async function enabledUser() {
  const secret = generateTotpSecret()
  const encrypted = await encryptSecret(secret, encryptionKey)
  const user = plainUser({
    totp_secret_ciphertext: encrypted.ciphertext,
    totp_secret_iv: encrypted.iv,
    totp_enabled_at: '2030-01-01T00:00:00.000Z',
  })
  return { secret, user }
}

async function pendingUser() {
  const secret = generateTotpSecret()
  const encrypted = await encryptSecret(secret, encryptionKey)
  const user = plainUser({
    totp_pending_ciphertext: encrypted.ciphertext,
    totp_pending_iv: encrypted.iv,
  })
  return { secret, user }
}

async function storedUser(password: string) {
  const hash = await hashPassword(password)
  const stored: StoredUser = {
    id: userId,
    username: 'alice',
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    disabled: 0,
    role: 'user',
    must_change_password: 0,
    kdf_salt: null,
    kdf_iterations: null,
    wrapped_master_key: null,
    recovery_wrapped_key: null,
    keys_updated_at: null,
  }
  return stored
}

function adminTarget(role: 'admin' | 'user' = 'user'): UserSummary {
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

test('login returns a challenge instead of a session when TOTP is enabled', async () => {
  const stored = await storedUser('correct-password')
  const { user } = await enabledUser()
  const auth = authRepository({ stored })
  const totp = totpRepository(user)
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/login', 'POST', { username: 'alice', password: 'correct-password' }),
    env: { DB: {} as D1Database },
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { totpRequired: boolean, challenge: string }
  assert.equal(body.totpRequired, true)
  assert.match(body.challenge, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(response.headers.get('Set-Cookie'), null)

  const created = totp.createdChallenges[0]
  assert.equal(created.userId, userId)
  assert.equal(created.tokenHash, await sha256(body.challenge))
  assert.equal(auth.sessions.length, 0)
})

test('login still issues a session when TOTP is not enabled', async () => {
  const stored = await storedUser('correct-password')
  const auth = authRepository({ stored })
  const totp = totpRepository(plainUser())
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/login', 'POST', { username: 'alice', password: 'correct-password' }),
    env: { DB: {} as D1Database },
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { user: { username: string } }
  assert.equal(body.user.username, 'alice')
  assert.match(response.headers.get('Set-Cookie') ?? '', /^cloudhub_session=/)
  assert.equal(auth.sessions.length, 1)
})

test('verify accepts a valid code, deletes the challenge, and issues a session', async () => {
  const { secret, user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const challenge = 'A'.repeat(43)
  const tokenHash = await sha256(challenge)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash,
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const step = Math.floor(Date.now() / 1000 / 30)
  const code = await totpCode(base32Decode(secret), step, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, code }),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { user: Record<string, unknown> }
  assert.deepEqual(body.user, { id: userId, username: 'alice', role: 'user', mustChangePassword: false, legacy: true, keysReady: false })
  assert.match(response.headers.get('Set-Cookie') ?? '', /^cloudhub_session=/)
  assert.ok(totp.deletedChallenges.includes(tokenHash))
  assert.equal(auth.sessions.length, 1)
  assert.equal(totp.lastSteps.length, 1)
})

test('verify rejects a wrong code, increments the failure count, and records a login failure', async () => {
  const { secret, user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const challenge = 'B'.repeat(43)
  const tokenHash = await sha256(challenge)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash,
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, code: stale }),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.deepEqual(totp.incrementedChallenges, [tokenHash])
  assert.equal(totp.deletedChallenges.length, 0)
  assert.equal(auth.loginFailures.length, 1)
  assert.deepEqual(auth.loginFailures[0], ['alice', 'ip-hash'])
})

test('verify deletes the challenge after the fifth failed attempt', async () => {
  const { secret, user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const challenge = 'C'.repeat(43)
  const tokenHash = await sha256(challenge)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash,
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  totp.challenges.get(tokenHash)!.failed_count = 4
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, code: stale }),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.deepEqual(totp.deletedChallenges, [tokenHash])
  assert.equal(totp.incrementedChallenges.length, 0)
  assert.equal(auth.loginFailures.length, 1)
})

test('verify rejects an expired or unknown challenge with 401', async () => {
  const { user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const expired = 'D'.repeat(43)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash: await sha256(expired),
    ipHash: 'ip-hash',
    createdAt: '2000-01-01T00:00:00.000Z',
    expiresAt: '2000-01-01T00:05:00.000Z',
  })
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  let response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge: expired, code: '123456' }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })

  response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge: 'E'.repeat(43), code: '123456' }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })

  assert.equal(auth.loginFailures.length, 0)
  assert.equal(totp.incrementedChallenges.length, 0)
  assert.equal(totp.deletedChallenges.length, 0)
})

test('verify accepts a recovery code once and rejects reuse', async () => {
  const { user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const recoveryCode = 'abcd-efgh'
  await totp.repository.createRecoveryCodes([{
    id: 'recovery-1',
    userId,
    codeHash: await sha256(recoveryCode),
    createdAt: '2030-01-01T00:00:00.000Z',
  }])
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  let challenge = 'F'.repeat(43)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash: await sha256(challenge),
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  let response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, recoveryCode }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(totp.markedUsed, ['recovery-1'])
  assert.equal(auth.sessions.length, 1)

  challenge = 'G'.repeat(43)
  await totp.repository.createLoginChallenge({
    id: 'challenge-2',
    userId,
    tokenHash: await sha256(challenge),
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, recoveryCode }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
})

test('setup generates a pending secret and an otpauth URL', async () => {
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(plainUser())
  const handler = createTotpSetupHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/totp/setup', 'POST', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { secret: string, otpauthUrl: string }
  assert.match(body.secret, /^[A-Z2-7]{32}$/u)
  assert.equal(body.otpauthUrl, otpauthUrl('alice', body.secret))
  assert.ok(totp.user!.totp_pending_ciphertext)
  assert.ok(totp.user!.totp_pending_iv)
  assert.equal(totp.user!.totp_secret_ciphertext, null)
})

test('setup returns 409 when TOTP is already enabled', async () => {
  const { user } = await enabledUser()
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpSetupHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/totp/setup', 'POST', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'totp_already_enabled' })
})

test('enable promotes the pending secret and returns one-time recovery codes', async () => {
  const { secret, user } = await pendingUser()
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpEnableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const step = Math.floor(Date.now() / 1000 / 30)
  const code = await totpCode(base32Decode(secret), step, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/enable', 'POST', { code }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { recoveryCodes: string[] }
  assert.equal(body.recoveryCodes.length, 10)
  for (const recoveryCode of body.recoveryCodes) {
    assert.match(recoveryCode, /^[a-z0-9]{4}-[a-z0-9]{4}$/u)
  }
  assert.ok(totp.user!.totp_secret_ciphertext)
  assert.equal(totp.user!.totp_pending_ciphertext, null)
  assert.ok(totp.user!.totp_enabled_at)
  assert.equal(totp.recoveryCodes.length, 10)
  for (const recoveryCode of body.recoveryCodes) {
    const codeHash = await sha256(recoveryCode)
    assert.ok(totp.recoveryCodes.some((stored) => stored.code_hash === codeHash))
  }
})

test('enable rejects a wrong code without enabling TOTP', async () => {
  const { secret, user } = await pendingUser()
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpEnableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/enable', 'POST', { code: stale }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.equal(totp.user!.totp_secret_ciphertext, null)
  assert.equal(totp.recoveryCodes.length, 0)
})

test('disable requires the password and a valid code, then clears TOTP and recovery codes', async () => {
  const { secret, user } = await enabledUser()
  const stored = await storedUser('correct-password')
  const auth = authRepository({ stored, sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpDisableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const step = Math.floor(Date.now() / 1000 / 30)
  const code = await totpCode(base32Decode(secret), step, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/disable', 'POST', { password: 'correct-password', code }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(totp.user!.totp_secret_ciphertext, null)
  assert.deepEqual(totp.deletedRecoveryUsers, [userId])
})

test('disable rejects a wrong password and records a login failure', async () => {
  const { user } = await enabledUser()
  const stored = await storedUser('correct-password')
  const auth = authRepository({ stored, sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpDisableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/totp/disable', 'POST', { password: 'wrong-password', code: '123456' }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(auth.loginFailures.length, 1)
})

test('disable rejects a wrong code after a correct password', async () => {
  const { secret, user } = await enabledUser()
  const stored = await storedUser('correct-password')
  const auth = authRepository({ stored, sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpDisableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/disable', 'POST', { password: 'correct-password', code: stale }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.ok(totp.user!.totp_secret_ciphertext)
})

test('admin reset clears TOTP, recovery codes, and sessions for another user', async () => {
  const { user } = await enabledUser()
  const auth = authRepository({ sessionUser: adminSessionUser, users: [adminTarget('user')] })
  const totp = totpRepository(user)
  const handler = createAdminTotpResetHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest(`/api/admin/users/${userId}/totp/reset`, 'POST', undefined, 'cloudhub_session=admin-token'),
    env: verifyEnv(),
    params: { id: userId },
  } as never)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(totp.disabledUsers, [userId])
  assert.deepEqual(totp.deletedRecoveryUsers, [userId])
  assert.deepEqual(auth.revokedAll, [userId])
})

test('admin reset rejects resetting yourself', async () => {
  const auth = authRepository({ sessionUser: adminSessionUser, users: [adminTarget('admin')] })
  const totp = totpRepository(null)
  const handler = createAdminTotpResetHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest(`/api/admin/users/${adminId}/totp/reset`, 'POST', undefined, 'cloudhub_session=admin-token'),
    env: verifyEnv(),
    params: { id: adminId },
  } as never)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })
})

test('TOTP management requires an authenticated user', async () => {
  const auth = authRepository({ sessionUser: null })
  const totp = totpRepository(null)
  const setup = createTotpSetupHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })
  const enable = createTotpEnableHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })
  const disable = createTotpDisableHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })
  const reset = createAdminTotpResetHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })

  assert.equal((await setup({ request: originRequest('/api/auth/totp/setup', 'POST'), env: verifyEnv() } as never)).status, 401)
  assert.equal((await enable({ request: originRequest('/api/auth/totp/enable', 'POST', { code: '123456' }), env: verifyEnv() } as never)).status, 401)
  assert.equal((await disable({ request: originRequest('/api/auth/totp/disable', 'POST', { password: 'password', code: '123456' }), env: verifyEnv() } as never)).status, 401)
  assert.equal((await reset({ request: originRequest(`/api/admin/users/${userId}/totp/reset`, 'POST'), env: verifyEnv(), params: { id: userId } } as never)).status, 401)
})

test('admin reset requires an admin role', async () => {
  const auth = authRepository({ sessionUser, users: [adminTarget('user')] })
  const totp = totpRepository(null)
  const handler = createAdminTotpResetHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest(`/api/admin/users/${userId}/totp/reset`, 'POST', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
    params: { id: userId },
  } as never)

  assert.equal(response.status, 403)
})
