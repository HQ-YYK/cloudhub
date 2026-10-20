import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { onRequest as logout } from '../api/auth/logout.ts'
import { onRequest as logoutAll } from '../api/auth/logout-all.ts'
import { onRequest as login } from '../api/auth/login.ts'
import { onRequest as me } from '../api/auth/me.ts'
import {
  getAuthenticatedUser,
  hashPassword,
  hashSessionToken,
  isLoginBlocked,
  sessionCookie,
  verifyPassword,
} from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'

function database(firstResult: unknown = null) {
  let runCount = 0
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => firstResult,
        run: async () => {
          runCount += 1
          return { success: true }
        },
      }),
    }),
    get runCount() {
      return runCount
    },
  }
  return db as unknown as D1Database & { readonly runCount: number }
}

function databaseWithSequence(firstResults: unknown[]) {
  let firstIndex = 0
  let runCount = 0
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => firstResults[firstIndex++],
        run: async () => {
          runCount += 1
          return { success: true }
        },
      }),
    }),
    get runCount() {
      return runCount
    },
  }
  return db as unknown as D1Database & { readonly runCount: number }
}

function repository(firstResult: unknown = null) {
  let touchCount = 0
  const authRepository: AuthRepository = {
    findUser: async () => null,
    findSessionUser: async () => firstResult as never,
    touchSession: async () => {
      touchCount += 1
    },
    findLoginAttempt: async () => null,
    upsertLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
  }
  return { authRepository, get touchCount() { return touchCount } }
}

test('password verification accepts the correct password and rejects a wrong one', async () => {
  const stored = await hashPassword('correct horse battery staple')
  assert.equal(
    await verifyPassword('correct horse battery staple', stored.hash, stored.salt, stored.iterations),
    true,
  )
  assert.equal(await verifyPassword('wrong password', stored.hash, stored.salt, stored.iterations), false)
})

test('session token hashes are deterministic and do not equal the token', async () => {
  const token = 'local-test-session-token'
  const hash = await hashSessionToken(token)
  assert.equal(hash, await hashSessionToken(token))
  assert.notEqual(hash, token)
})

test('authenticated user lookup rejects an expired or disabled session', async () => {
  const request = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: sessionCookie('test-token') },
  })
  const validRepository = repository({ session_id: 'session-1', id: 'user-1', username: 'alice' })
  assert.deepEqual(await getAuthenticatedUser(validRepository.authRepository, request), {
    id: 'user-1',
    username: 'alice',
  })
  assert.equal(validRepository.touchCount, 1)
  assert.equal(await getAuthenticatedUser(repository().authRepository, request), null)
})

test('rate limiting blocks an attempt during its block window', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(isLoginBlocked({
    failed_count: 5,
    window_started_at: now.toISOString(),
    blocked_until: '2026-01-01T00:10:00.000Z',
  }, now), true)
  assert.equal(isLoginBlocked(null, now), false)
})

test('login rejects malformed JSON without exposing internals', async () => {
  const response = await login({
    request: new Request('https://cloudhub.test/api/auth/login', {
      method: 'POST',
      body: '{not-json',
      headers: { Origin: 'https://cloudhub.test' },
    }),
    env: { DB: database() },
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })
})

test('login rejects cross-origin requests before reading credentials', async () => {
  const response = await login({
    request: new Request('https://cloudhub.test/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'https://attacker.test' },
      body: JSON.stringify({ username: 'alice', password: 'not-a-real-password' }),
    }),
    env: { DB: database() },
  } as never)
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'forbidden' })
})

test('authentication responses disable caching', async () => {
  const response = await me({
    request: new Request('https://cloudhub.test/api/auth/me'),
    env: { DB: database() },
  } as never)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
})

test('me rejects a request without a session', async () => {
  const response = await me({
    request: new Request('https://cloudhub.test/api/auth/me'),
    env: { DB: database() },
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'unauthorized' })
})

test('logout deletes the hashed session and clears the cookie', async () => {
  const db = database()
  const response = await logout({
    request: new Request('https://cloudhub.test/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('test-token'),
        Origin: 'https://cloudhub.test',
      },
    }),
    env: { DB: db },
  } as never)
  assert.equal(response.status, 200)
  assert.equal(db.runCount, 1)
  assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/)
})

test('logout rejects a malformed cross-site referer', async () => {
  const response = await logout({
    request: new Request('https://cloudhub.test/api/auth/logout', {
      method: 'POST',
      headers: { Referer: 'not-a-url' },
    }),
    env: { DB: database() },
  } as never)
  assert.equal(response.status, 403)
})

test('logout-all revokes every session for the authenticated user', async () => {
  const db = databaseWithSequence([
    { session_id: 'current', id: 'user-1', username: 'alice' },
  ])
  const response = await logoutAll({
    request: new Request('https://cloudhub.test/api/auth/logout-all', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('test-token'),
        Origin: 'https://cloudhub.test',
      },
    }),
    env: { DB: db },
  } as never)
  assert.equal(response.status, 200)
  assert.equal(db.runCount, 2)
  assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/)
})
