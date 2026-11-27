import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { onRequest as logout } from '../api/auth/logout.ts'
import { onRequest as logoutAll } from '../api/auth/logout-all.ts'
import { onRequest as login } from '../api/auth/login.ts'
import { onRequest as me } from '../api/auth/me.ts'
import { onRequest as health } from '../api/health.ts'
import {
  getAuthenticatedUser,
  hashPassword,
  hashSessionToken,
  isLoginBlocked,
  recordLoginFailure,
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
  let lastBind: unknown[] = []
  const db = {
    prepare: () => ({
      bind: (...values: unknown[]) => {
        lastBind = values
        return {
        first: async () => firstResults[firstIndex++],
        run: async () => {
          runCount += 1
          return { success: true }
        },
        }
      },
    }),
    get runCount() {
      return runCount
    },
    get lastBind() {
      return lastBind
    },
  }
  return db as unknown as D1Database & { readonly runCount: number; readonly lastBind: unknown[] }
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

test('hashPassword rejects iterations above the PBKDF2 limit', async () => {
  await assert.rejects(
    hashPassword('password', crypto.getRandomValues(new Uint8Array(16)), 100001),
    /pbkdf2_iteration_limit_exceeded/u,
  )
})

test('verifyPassword rejects high-iteration records without throwing', async () => {
  const stored = await hashPassword('password')
  assert.equal(await verifyPassword('password', stored.hash, stored.salt, 100000 * 3 + 10000), false)
})

test('session token hashes are deterministic and do not equal the token', async () => {
  const token = 'local-test-session-token'
  const hash = await hashSessionToken(token)
  assert.equal(hash, await hashSessionToken(token))
  assert.notEqual(hash, token)
})

test('malformed, empty, and invalid session cookies are treated as anonymous', async () => {
  const malformed = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: 'cloudhub_session=%invalid' },
  })
  const empty = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: 'cloudhub_session=' },
  })
  const invalid = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: 'cloudhub_session=not-a-valid-session' },
  })
  const authRepository = repository().authRepository

  assert.equal(await getAuthenticatedUser(authRepository, malformed), null)
  assert.equal(await getAuthenticatedUser(authRepository, empty), null)
  assert.equal(await getAuthenticatedUser(authRepository, invalid), null)
})

test('authenticated user lookup rejects an expired or disabled session', async () => {
  const request = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: sessionCookie('test-token') },
  })
  const validRepository = repository({ session_id: 'session-1', id: 'user-1', username: 'alice', role: 'user', must_change_password: 0 })
  assert.deepEqual(await getAuthenticatedUser(validRepository.authRepository, request), {
    id: 'user-1',
    username: 'alice',
    role: 'user',
    mustChangePassword: false,
    sessionId: 'session-1',
    keysReady: false,
  })
  assert.equal(validRepository.touchCount, 1)
  assert.equal(await getAuthenticatedUser(repository().authRepository, request), null)
})

test('session touch is skipped when last_seen_at is within the interval', async () => {
  const now = new Date('2026-01-01T00:05:00.000Z')
  const request = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: sessionCookie('test-token') },
  })
  const recent = repository({
    session_id: 'session-1',
    id: 'user-1',
    username: 'alice',
    role: 'user',
    must_change_password: 0,
    last_seen_at: '2026-01-01T00:04:59.000Z',
  })

  const user = await getAuthenticatedUser(recent.authRepository, request, now)

  assert.equal(user?.id, 'user-1')
  assert.equal(recent.touchCount, 0)
})

test('session touch runs when last_seen_at is older than the interval', async () => {
  const now = new Date('2026-01-01T00:05:00.000Z')
  const request = new Request('https://cloudhub.test/api/auth/me', {
    headers: { Cookie: sessionCookie('test-token') },
  })
  const stale = repository({
    session_id: 'session-1',
    id: 'user-1',
    username: 'alice',
    role: 'user',
    must_change_password: 0,
    last_seen_at: '2025-12-31T23:59:59.000Z',
  })

  const user = await getAuthenticatedUser(stale.authRepository, request, now)

  assert.equal(user?.id, 'user-1')
  assert.equal(stale.touchCount, 1)
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

test('recording a login failure passes the atomic rate-limit policy to the repository', async () => {
  let call: unknown[] = []
  const authRepository = repository().authRepository
  authRepository.recordLoginFailure = async (...args) => {
    call = args
  }

  await recordLoginFailure(
    authRepository,
    'alice',
    'ip-hash',
    new Date('2026-01-01T00:00:00.000Z'),
  )

  assert.deepEqual(call, [
    'alice',
    'ip-hash',
    '2026-01-01T00:00:00.000Z',
    15 * 60 * 1000,
    5,
    15 * 60 * 1000,
  ])
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
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
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

test('health responses disable caching for success, missing DB, failure, and method errors', async () => {
  const successDb = {
    prepare: () => ({ first: async () => ({ ok: 1 }) }),
  }
  const failingDb = {
    prepare: () => ({
      first: async () => {
        throw new Error('database failure')
      },
    }),
  }
  const cases = [
    await health({ request: new Request('https://cloudhub.test/api/health'), env: { DB: successDb } } as never),
    await health({ request: new Request('https://cloudhub.test/api/health'), env: {} } as never),
    await health({ request: new Request('https://cloudhub.test/api/health'), env: { DB: failingDb } } as never),
    await health({
      request: new Request('https://cloudhub.test/api/health', { method: 'POST' }),
      env: { DB: successDb },
    } as never),
  ]

  assert.deepEqual(cases.map((response) => response.status), [200, 503, 503, 405])
  for (const response of cases) {
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  assert.equal(cases[3].headers.get('Allow'), 'GET')
})

test('me rejects a request without a session', async () => {
  const response = await me({
    request: new Request('https://cloudhub.test/api/auth/me'),
    env: { DB: database() },
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'unauthorized' })
})

test('me returns only public user fields', async () => {
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => sql.includes('FROM sessions')
          ? { session_id: 'session-1', id: 'user-1', username: 'alice', role: 'admin', must_change_password: 0, kdf_salt: 'somesalt', wrapped_master_key: null }
          : null,
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database
  const response = await me({
    request: new Request('https://cloudhub.test/api/auth/me', {
      headers: { Cookie: 'cloudhub_session=valid-token' },
    }),
    env: { DB: db },
  } as never)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Server-Timing') ?? '', /^auth;dur=\d+, db;dur=\d+, total;dur=\d+$/u)
  const body = await response.json() as { user: Record<string, unknown> }
  assert.deepEqual(body.user, {
    id: 'user-1',
    username: 'alice',
    role: 'admin',
    mustChangePassword: false,
    keysReady: false,
    totpEnabled: false,
    passkeyCount: 0,
  })
  assert.equal('sessionId' in body.user, false)
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
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
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
  assert.deepEqual(db.lastBind, ['user-1'])
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.match(response.headers.get('Set-Cookie') ?? '', /Max-Age=0/)
})

test('database errors return generic service-unavailable responses', async () => {
  const failingDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          throw new Error('internal database detail')
        },
        run: async () => {
          throw new Error('internal database detail')
        },
      }),
    }),
  }
  const response = await me({
    request: new Request('https://cloudhub.test/api/auth/me', {
      headers: { Cookie: sessionCookie('test-token') },
    }),
    env: { DB: failingDb },
  } as never)

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'service_unavailable' })
})
