import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, StoredUser } from '../../_lib/auth-repository.ts'
import { isValidKdfSalt } from '../../_lib/keys.ts'
import { createPreloginHandler } from './prelogin.ts'

const userId = '11111111-1111-4111-8111-111111111111'
const encryptionKey = Buffer.from('1'.repeat(32), 'ascii').toString('base64url')
const kdfSalt = Buffer.alloc(16, 1).toString('base64url')

function stored(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: userId,
    username: 'alice',
    password_hash: 'x',
    password_salt: 'x',
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

function repository(user: StoredUser | null): AuthRepository {
  return {
    findUser: async (username) => user && user.username === username ? user : null,
    findSessionUser: async () => null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async () => undefined,
  }
}

function originRequest(username: string) {
  return new Request('https://cloudhub.test/api/auth/prelogin', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })
}

function env() {
  return { DB: {} as D1Database, STORAGE_ENCRYPTION_KEY: encryptionKey }
}

test('prelogin returns real kdf parameters for a new-format account', async () => {
  const handler = createPreloginHandler({
    createAuthRepository: () => repository(stored({ kdf_salt: kdfSalt, kdf_iterations: 600000 })),
  })

  const response = await handler({ request: originRequest('alice'), env: env() } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { legacy: false, kdfSalt, kdfIterations: 600000 })
})

test('prelogin marks a legacy account', async () => {
  const handler = createPreloginHandler({ createAuthRepository: () => repository(stored()) })

  const response = await handler({ request: originRequest('alice'), env: env() } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { legacy: true })
})

test('prelogin returns a deterministic fake salt for unknown users', async () => {
  const handler = createPreloginHandler({ createAuthRepository: () => repository(null) })

  const first = await handler({ request: originRequest('alice'), env: env() } as never)
  const second = await handler({ request: originRequest('alice'), env: env() } as never)
  const other = await handler({ request: originRequest('bob'), env: env() } as never)

  assert.equal(first.status, 200)
  const firstBody = await first.json() as { legacy: boolean; kdfSalt: string; kdfIterations: number }
  assert.equal(firstBody.legacy, false)
  assert.equal(firstBody.kdfIterations, 600000)
  assert.equal(isValidKdfSalt(firstBody.kdfSalt), true)
  assert.deepEqual(await second.json(), firstBody)
  assert.notDeepEqual(await other.json(), firstBody)
})

test('prelogin treats a disabled account like an unknown user', async () => {
  const handler = createPreloginHandler({
    createAuthRepository: () => repository(stored({ disabled: 1, kdf_salt: kdfSalt, kdf_iterations: 600000 })),
  })

  const response = await handler({ request: originRequest('alice'), env: env() } as never)
  assert.equal(response.status, 200)
  const body = await response.json() as { legacy: boolean; kdfSalt: string; kdfIterations: number }
  assert.equal(body.legacy, false)
  assert.equal(body.kdfIterations, 600000)
  assert.notEqual(body.kdfSalt, kdfSalt)
})

test('prelogin returns 503 without a storage encryption key', async () => {
  const handler = createPreloginHandler({ createAuthRepository: () => repository(stored()) })

  const response = await handler({ request: originRequest('alice'), env: { DB: {} as D1Database } } as never)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'service_unavailable' })
})
