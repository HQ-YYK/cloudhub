import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { onRequest as listFiles } from './index.ts'
import { onRequest as createDirectory } from './directories.ts'

function context(request: Request, DB?: D1Database) {
  return { request, env: { DB } } as never
}

test('file list and directory creation reject unsupported methods with Allow', async () => {
  const listResponse = await listFiles(context(new Request('https://cloudhub.test/api/files', { method: 'POST' })))
  assert.equal(listResponse.status, 405)
  assert.equal(listResponse.headers.get('Allow'), 'GET')

  const createResponse = await createDirectory(context(new Request('https://cloudhub.test/api/files/directories')))
  assert.equal(createResponse.status, 405)
  assert.equal(createResponse.headers.get('Allow'), 'POST')
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
