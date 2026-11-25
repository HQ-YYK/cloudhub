import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, StoredUser } from '../../_lib/auth-repository.ts'
import { hashPassword } from '../../_lib/auth.ts'
import type { KeysRepository, UpdateKeysInput } from '../../_lib/keys.ts'
import { createPasswordHandler } from './password.ts'

const kdfSalt = Buffer.alloc(16, 1).toString('base64url')
const authKey = Buffer.alloc(32, 2).toString('base64url')
const wrapped = Buffer.alloc(60, 3).toString('base64url')
const recovery = Buffer.alloc(60, 4).toString('base64url')

function stored(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: '11111111-1111-4111-8111-111111111111',
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

function originRequest(path: string, body: unknown) {
  return new Request(`https://cloudhub.test${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://cloudhub.test',
      'Content-Type': 'application/json',
      Cookie: 'cloudhub_session=token'
    },
    body: JSON.stringify(body),
  })
}

function repository(storedUser: StoredUser) {
  const keyUpdates: Array<{ userId: string; input: UpdateKeysInput }> = []
  let loginFailures = 0
  let revokedKeep = ''

  const authRepository: AuthRepository = {
    findUser: async (username) => username === storedUser.username ? storedUser : null,
    findSessionUser: async () => ({
      session_id: 'current-session',
      id: storedUser.id,
      username: storedUser.username,
      role: storedUser.role,
      must_change_password: storedUser.must_change_password,
    }),
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => { loginFailures += 1 },
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async (_id, keepSessionId) => { revokedKeep = keepSessionId },
  }

  const keysRepository: KeysRepository = {
    updateKeys: async (userId, input) => { keyUpdates.push({ userId, input }) },
    updateRecoveryKey: async () => undefined,
  }

  return {
    authRepository,
    keysRepository,
    get keyUpdates() { return keyUpdates },
    get loginFailures() { return loginFailures },
    get revokedKeep() { return revokedKeep },
  }
}

test('legacy account first-time setup requires a recovery key and stores new keys', async () => {
  const legacyHash = await hashPassword('current-password')
  const current = repository(stored({
    password_hash: legacyHash.hash,
    password_salt: legacyHash.salt,
    password_iterations: legacyHash.iterations,
    must_change_password: 1,
  }))
  const handler = createPasswordHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })
  const env = { DB: {} as D1Database }

  let response = await handler({
    request: originRequest('/api/auth/password', {
      currentPassword: 'current-password',
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
    }),
    env,
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })

  response = await handler({
    request: originRequest('/api/auth/password', {
      currentPassword: 'current-password',
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
      recoveryWrappedKey: recovery,
    }),
    env,
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(current.keyUpdates.length, 1)
  assert.equal(current.keyUpdates[0].userId, stored().id)
  assert.equal(current.keyUpdates[0].input.recoveryWrappedKey, recovery)
  assert.equal(current.keyUpdates[0].input.mustChangePassword, 0)
  assert.equal(current.keyUpdates[0].input.kdfIterations, 600000)
  assert.equal(current.revokedKeep, 'current-session')
})

test('new-format account keeps its recovery key when none is provided', async () => {
  const currentAuthKey = Buffer.alloc(32, 9).toString('base64url')
  const currentHash = await hashPassword(currentAuthKey)
  const current = repository(stored({
    password_hash: currentHash.hash,
    password_salt: currentHash.salt,
    password_iterations: currentHash.iterations,
    kdf_salt: Buffer.alloc(16, 9).toString('base64url'),
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    recovery_wrapped_key: recovery,
    keys_updated_at: '2030-01-01T00:00:00.000Z',
  }))
  const handler = createPasswordHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('/api/auth/password', {
      currentAuthKey,
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
    }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(current.keyUpdates.length, 1)
  assert.equal(current.keyUpdates[0].input.recoveryWrappedKey, recovery)
})

test('password change rejects malformed key fields before checking credentials', async () => {
  const legacyHash = await hashPassword('current-password')
  const current = repository(stored({
    password_hash: legacyHash.hash,
    password_salt: legacyHash.salt,
    password_iterations: legacyHash.iterations,
  }))
  const handler = createPasswordHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('/api/auth/password', {
      currentPassword: 'current-password',
      newKdfSalt: 'bad',
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
      recoveryWrappedKey: recovery,
    }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })
  assert.equal(current.keyUpdates.length, 0)
})

test('password change records a login failure on a wrong current credential', async () => {
  const legacyHash = await hashPassword('correct-password')
  const current = repository(stored({
    password_hash: legacyHash.hash,
    password_salt: legacyHash.salt,
    password_iterations: legacyHash.iterations,
  }))
  const handler = createPasswordHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('/api/auth/password', {
      currentPassword: 'wrong-password',
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
      recoveryWrappedKey: recovery,
    }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(current.loginFailures, 1)
  assert.equal(current.keyUpdates.length, 0)
})

test('new-format account rejects a legacy password credential type', async () => {
  const currentAuthKey = Buffer.alloc(32, 9).toString('base64url')
  const currentHash = await hashPassword(currentAuthKey)
  const current = repository(stored({
    password_hash: currentHash.hash,
    password_salt: currentHash.salt,
    password_iterations: currentHash.iterations,
    kdf_salt: Buffer.alloc(16, 9).toString('base64url'),
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    recovery_wrapped_key: recovery,
  }))
  const handler = createPasswordHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('/api/auth/password', {
      currentPassword: 'anything',
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
    }),
    env: { DB: {} as D1Database },
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })
  assert.equal(current.keyUpdates.length, 0)
})
