import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { onRequest as logout } from '../api/auth/logout.ts'
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
  const validDb = database({ session_id: 'session-1', id: 'user-1', username: 'alice' })
  assert.deepEqual(await getAuthenticatedUser(validDb, request), {
    id: 'user-1',
    username: 'alice',
  })
  assert.equal(validDb.runCount, 1)
  assert.equal(await getAuthenticatedUser(database(null), request), null)
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
    }),
    env: { DB: database() },
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })
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
