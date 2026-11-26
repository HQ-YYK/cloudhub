import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { sessionCookie } from '../../_lib/auth.ts'
import { onRequest as listFiles } from './index.ts'
import { onRequest as createDirectory } from './directories.ts'

function context(request: Request, DB?: D1Database) {
  return { request, env: { DB } } as never
}

const dirId = '33333333-3333-4333-8333-333333333333'
const encName = 'A'.repeat(44)
const nameKey = 'A'.repeat(43)

function dirBody(overrides: Record<string, unknown> = {}) {
  return { parent_id: null, id: dirId, encName, nameKey, ...overrides }
}

function trackingDatabase() {
  let prepareCount = 0
  const db = {
    prepare: () => {
      prepareCount += 1
      return {
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
      }
    },
    get prepareCount() {
      return prepareCount
    },
  }
  return db as unknown as D1Database & { readonly prepareCount: number }
}

test('file list and directory creation reject unsupported methods with Allow', async () => {
  const listResponse = await listFiles(context(new Request('https://cloudhub.test/api/files', { method: 'POST' })))
  assert.equal(listResponse.status, 405)
  assert.equal(listResponse.headers.get('Allow'), 'GET')

  const createResponse = await createDirectory(context(new Request('https://cloudhub.test/api/files/directories')))
  assert.equal(createResponse.status, 405)
  assert.equal(createResponse.headers.get('Allow'), 'POST')
})

test('directory creation accepts same-origin requests and rejects missing or foreign origins before database access', async () => {
  const sameOriginDb = trackingDatabase()
  const sameOrigin = await createDirectory(context(
    new Request('https://cloudhub.test/api/files/directories', {
      method: 'POST',
      headers: {
        Origin: 'https://cloudhub.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dirBody()),
    }),
    sameOriginDb,
  ))
  assert.equal(sameOrigin.status, 401)
  assert.equal(sameOriginDb.prepareCount, 0)

  for (const headers of [
    {},
    { Origin: 'https://attacker.test' },
    { Referer: 'https://attacker.test/form' },
    { Referer: 'not a URL' },
  ] as Array<Record<string, string>>) {
    const db = trackingDatabase()
    const response = await createDirectory(context(
      new Request('https://cloudhub.test/api/files/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(dirBody()),
      }),
      db,
    ))
    assert.equal(response.status, 403)
    assert.equal(db.prepareCount, 0)
  }
})

test('directory creation rejects malformed JSON and non-object JSON bodies with 400', async () => {
  for (const body of ['not-json', 'null', '[]', '"text"', '42']) {
    const response = await createDirectory(context(
      new Request('https://cloudhub.test/api/files/directories', {
        method: 'POST',
        headers: {
          Origin: 'https://cloudhub.test',
          'Content-Type': 'application/json',
        },
        body,
      }),
      trackingDatabase(),
    ))
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_request' })
  }

  const invalidParent = await createDirectory(context(
    new Request('https://cloudhub.test/api/files/directories', {
      method: 'POST',
      headers: {
        Origin: 'https://cloudhub.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dirBody({ parent_id: 42 })),
    }),
    trackingDatabase(),
  ))
  assert.equal(invalidParent.status, 400)
})

test('private file routes return generic unavailable and unauthenticated responses', async () => {
  const unavailable = await listFiles(context(new Request('https://cloudhub.test/api/files', { method: 'GET' })))
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.headers.get('Cache-Control'), 'no-store')

  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database
  const unauthenticated = await listFiles(context(
    new Request('https://cloudhub.test/api/files', { method: 'GET' }),
    db,
  ))
  assert.equal(unauthenticated.status, 401)
  assert.deepEqual(await unauthenticated.json(), { error: 'unauthorized' })
})

function authenticatedListDb() {
  const sessionUser = {
    session_id: 'session-1',
    id: 'user-1',
    username: 'alice',
    role: 'user',
    must_change_password: 0,
    last_seen_at: '2026-01-01T00:04:59.000Z',
  }
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => (sql.includes('FROM sessions') ? sessionUser : null),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database
}

test('file list reports a Server-Timing header without user data', async () => {
  const response = await listFiles(context(
    new Request('https://cloudhub.test/api/files', {
      method: 'GET',
      headers: { Cookie: sessionCookie('test-token') },
    }),
    authenticatedListDb(),
  ))

  assert.equal(response.status, 200)
  const timing = response.headers.get('Server-Timing') ?? ''
  assert.match(timing, /^auth;dur=\d+, db;dur=\d+, total;dur=\d+$/u)
  assert.doesNotMatch(timing, /alice|user-1|session-1/u)
})

function authenticatedCreateDb() {
  const sessionUser = {
    session_id: 'session-1',
    id: 'user-1',
    username: 'alice',
    role: 'user',
    must_change_password: 0,
    last_seen_at: '2026-01-01T00:04:59.000Z',
  }
  const created = {
    id: dirId,
    owner_id: 'user-1',
    parent_id: null,
    kind: 'directory',
    name: encName,
    name_key: nameKey,
    object_key: null,
    size_bytes: null,
    mime_type: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
    enc: 1,
    wrapped_key: null,
  }
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => (sql.includes('FROM sessions') ? sessionUser : sql.includes('FROM files') ? created : null),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database
}

test('directory creation reports a Server-Timing header without user data', async () => {
  const response = await createDirectory(context(
    new Request('https://cloudhub.test/api/files/directories', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('test-token'),
        Origin: 'https://cloudhub.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dirBody()),
    }),
    authenticatedCreateDb(),
  ))

  assert.equal(response.status, 201)
  const timing = response.headers.get('Server-Timing') ?? ''
  assert.match(timing, /^auth;dur=\d+, db;dur=\d+, total;dur=\d+$/u)
  assert.doesNotMatch(timing, /alice|user-1|session-1/u)
})
