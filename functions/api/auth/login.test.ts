import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, StoredUser } from '../../_lib/auth-repository.ts'
import { hashPassword } from '../../_lib/auth.ts'
import type { TotpRepository } from '../../_lib/totp-repository.ts'
import { createLoginHandler } from './login.ts'

const userId = '11111111-1111-4111-8111-111111111111'
const authKey = Buffer.alloc(32, 2).toString('base64url')
const kdfSalt = Buffer.alloc(16, 1).toString('base64url')
const wrapped = Buffer.alloc(60, 3).toString('base64url')

function stored(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: userId,
    username: 'alice',
    password_hash: '',
    password_salt: '',
    password_iterations: 100000,
    disabled: 0,
    role: 'user',
    must_change_password: 0,
    kdf_salt: null,
    kdf_iterations: null,
    wrapped_master_key: null,
    recovery_wrapped_key: null,
    keys_updated_at: null,
    ...overrides,
  }
}

function authRepository(user: StoredUser | null) {
  const failures: string[] = []
  const sessions: string[] = []
  const repository: AuthRepository = {
    findUser: async (username) => user && user.username === username ? user : null,
    findSessionUser: async () => null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async (username) => { failures.push(username) },
    clearLoginFailures: async () => undefined,
    createSession: async (session) => { sessions.push(session.userId) },
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async () => undefined,
  }
  return { repository, get failures() { return failures }, get sessions() { return sessions } }
}

function totpRepository(): TotpRepository {
  return {
    findTotpUser: async () => null,
    setPendingSecret: async () => undefined,
    enableTotp: async () => undefined,
    disableTotp: async () => undefined,
    updateLastStep: async () => false,
    createRecoveryCodes: async () => undefined,
    deleteRecoveryCodes: async () => undefined,
    findRecoveryCode: async () => null,
    markRecoveryCodeUsed: async () => false,
    createLoginChallenge: async () => undefined,
    findLoginChallengeByTokenHash: async () => null,
    incrementLoginChallengeFailure: async () => undefined,
    deleteLoginChallengeByTokenHash: async () => false,
  }
}

function originRequest(body: unknown) {
  return new Request('https://cloudhub.test/api/auth/login', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('new-format account logs in with an auth key and reports key readiness', async () => {
  const hash = await hashPassword(authKey)
  const user = stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
  })
  const auth = authRepository(user)
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totpRepository(),
  })

  const response = await handler({
    request: originRequest({ username: 'alice', authKey }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 200)
  const body = await response.json() as { user: { legacy: boolean; keysReady: boolean } }
  assert.equal(body.user.legacy, false)
  assert.equal(body.user.keysReady, true)
  assert.equal(auth.sessions.length, 1)
  assert.equal(auth.failures.length, 0)
})

test('new-format account rejects a password field as invalid credentials', async () => {
  const hash = await hashPassword(authKey)
  const user = stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
  })
  const auth = authRepository(user)
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totpRepository(),
  })

  const response = await handler({
    request: originRequest({ username: 'alice', password: 'anything' }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(auth.failures.length, 1)
})

test('legacy account rejects an auth key field as invalid credentials', async () => {
  const hash = await hashPassword('correct-password')
  const user = stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
  })
  const auth = authRepository(user)
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totpRepository(),
  })

  const response = await handler({
    request: originRequest({ username: 'alice', authKey }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(auth.failures.length, 1)
})

test('legacy account still logs in with a password', async () => {
  const hash = await hashPassword('correct-password')
  const user = stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
  })
  const auth = authRepository(user)
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totpRepository(),
  })

  const response = await handler({
    request: originRequest({ username: 'alice', password: 'correct-password' }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 200)
  const body = await response.json() as { user: { legacy: boolean; keysReady: boolean } }
  assert.equal(body.user.legacy, true)
  assert.equal(body.user.keysReady, false)
  assert.equal(auth.sessions.length, 1)
})
