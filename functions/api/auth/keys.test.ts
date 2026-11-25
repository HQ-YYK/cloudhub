import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, StoredUser } from '../../_lib/auth-repository.ts'
import { hashPassword } from '../../_lib/auth.ts'
import type { KeysRepository, UpdateKeysInput } from '../../_lib/keys.ts'
import { createKeysHandler } from './keys.ts'
import { createKeysRecoveryHandler } from './keys/recovery.ts'
import { createKeysResetHandler } from './keys/reset.ts'

const userId = '11111111-1111-4111-8111-111111111111'
const authKey = Buffer.alloc(32, 2).toString('base64url')
const currentAuthKey = Buffer.alloc(32, 9).toString('base64url')
const kdfSalt = Buffer.alloc(16, 1).toString('base64url')
const wrapped = Buffer.alloc(60, 3).toString('base64url')
const recovery = Buffer.alloc(60, 4).toString('base64url')

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

function repository(storedUser: StoredUser | null) {
  const failures: string[] = []
  const keyUpdates: UpdateKeysInput[] = []
  const recoveryUpdates: string[] = []
  const revokedKeep: string[] = []

  const authRepository: AuthRepository = {
    findUser: async (username) => storedUser && storedUser.username === username ? storedUser : null,
    findSessionUser: async () => storedUser
      ? {
        session_id: 'current-session',
        id: storedUser.id,
        username: storedUser.username,
        role: storedUser.role,
        must_change_password: storedUser.must_change_password,
      }
      : null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async (username) => { failures.push(username) },
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async (id, keepSessionId) => { revokedKeep.push(`${id}:${keepSessionId}`) },
  }

  const keysRepository: KeysRepository = {
    updateKeys: async (_userId, input) => { keyUpdates.push(input) },
    updateRecoveryKey: async (_userId, recoveryWrappedKey) => { recoveryUpdates.push(recoveryWrappedKey) },
  }

  return {
    authRepository,
    keysRepository,
    get failures() { return failures },
    get keyUpdates() { return keyUpdates },
    get recoveryUpdates() { return recoveryUpdates },
    get revokedKeep() { return revokedKeep },
  }
}

function originRequest(method: string, path: string, body?: unknown) {
  return new Request(`https://cloudhub.test${path}`, {
    method,
    headers: {
      Origin: 'https://cloudhub.test',
      'Content-Type': 'application/json',
      Cookie: 'cloudhub_session=token'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function env() {
  return { DB: {} as D1Database }
}

test('GET keys returns the stored key material for a new-format account', async () => {
  const current = repository(stored({
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    recovery_wrapped_key: recovery,
  }))
  const handler = createKeysHandler({ createAuthRepository: () => current.authRepository })

  const response = await handler({ request: originRequest('GET', '/api/auth/keys'), env: env() } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    kdfSalt,
    kdfIterations: 600000,
    wrappedMasterKey: wrapped,
    recoveryWrappedKey: recovery,
  })
})

test('GET keys returns null key fields for an account without key material', async () => {
  const current = repository(stored())
  const handler = createKeysHandler({ createAuthRepository: () => current.authRepository })

  const response = await handler({ request: originRequest('GET', '/api/auth/keys'), env: env() } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    kdfSalt: null,
    kdfIterations: null,
    wrappedMasterKey: null,
    recoveryWrappedKey: null,
  })
})

test('keys/recovery replaces the recovery key for an eligible account', async () => {
  const hash = await hashPassword(currentAuthKey)
  const current = repository(stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    recovery_wrapped_key: recovery,
  }))
  const handler = createKeysRecoveryHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('POST', '/api/auth/keys/recovery', { currentAuthKey, recoveryWrappedKey: recovery }),
    env: env(),
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(current.recoveryUpdates, [recovery])
})

test('keys/recovery rejects an account without keys', async () => {
  const current = repository(stored())
  const handler = createKeysRecoveryHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('POST', '/api/auth/keys/recovery', { currentAuthKey: authKey, recoveryWrappedKey: recovery }),
    env: env(),
  } as never)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'keys_not_ready' })
})

test('keys/recovery records a failure on a wrong current auth key', async () => {
  const hash = await hashPassword(currentAuthKey)
  const current = repository(stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    recovery_wrapped_key: recovery,
  }))
  const handler = createKeysRecoveryHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const wrongAuthKey = Buffer.alloc(32, 8).toString('base64url')
  const response = await handler({
    request: originRequest('POST', '/api/auth/keys/recovery', { currentAuthKey: wrongAuthKey, recoveryWrappedKey: recovery }),
    env: env(),
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(current.failures.length, 1)
  assert.equal(current.recoveryUpdates.length, 0)
})

test('keys/reset replaces keys for a must-change-password new-format account', async () => {
  const hash = await hashPassword(currentAuthKey)
  const current = repository(stored({
    password_hash: hash.hash,
    password_salt: hash.salt,
    password_iterations: hash.iterations,
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    recovery_wrapped_key: recovery,
    must_change_password: 1,
  }))
  const handler = createKeysResetHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('POST', '/api/auth/keys/reset', {
      currentAuthKey,
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
      recoveryWrappedKey: recovery,
    }),
    env: env(),
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(current.keyUpdates.length, 1)
  assert.equal(current.keyUpdates[0].mustChangePassword, 0)
  assert.equal(current.keyUpdates[0].kdfIterations, 600000)
  assert.deepEqual(current.revokedKeep, [`${userId}:current-session`])
})

test('keys/reset rejects an account that is not in the reset state', async () => {
  const current = repository(stored({
    kdf_salt: kdfSalt,
    kdf_iterations: 600000,
    wrapped_master_key: wrapped,
    must_change_password: 0,
  }))
  const handler = createKeysResetHandler({
    createAuthRepository: () => current.authRepository,
    createKeysRepository: () => current.keysRepository,
  })

  const response = await handler({
    request: originRequest('POST', '/api/auth/keys/reset', {
      currentAuthKey: authKey,
      newKdfSalt: kdfSalt,
      newAuthKey: authKey,
      wrappedMasterKey: wrapped,
      recoveryWrappedKey: recovery,
    }),
    env: env(),
  } as never)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'reset_not_allowed' })
})
