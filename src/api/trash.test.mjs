import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyTrash, listTrash, purgeTrashItem, restoreTrashItem } from './trash.ts'
import { FilesRequestError } from './files.ts'

function mockFetch(response, capture) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    capture(input, init)
    return response
  }
  return () => {
    globalThis.fetch = original
  }
}

test('listTrash returns the items array', async () => {
  const items = [{
    id: 'file/1',
    parent_id: null,
    kind: 'file',
    name: 'report.pdf',
    size_bytes: 1024,
    mime_type: 'application/pdf',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    deleted_at: '2026-01-02',
    expires_at: '2026-02-01',
    parent_name: null,
  }]
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ items }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await listTrash(), items)
    assert.equal(request.input, '/api/trash')
    assert.equal(request.init.credentials, 'same-origin')
  } finally {
    restore()
  }
})

test('restore surfaces the 409 conflict error code', async () => {
  const restore = mockFetch(
    new Response(JSON.stringify({ error: 'conflict' }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    () => {},
  )
  try {
    await assert.rejects(
      () => restoreTrashItem('file/id'),
      (error) => error instanceof FilesRequestError && error.status === 409 && error.code === 'conflict',
    )
  } finally {
    restore()
  }
})

test('purge uses DELETE and the encoded id', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ purged: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    const result = await purgeTrashItem('file/id')
    assert.deepEqual(result, { purged: 1, remaining: 0 })
    assert.equal(request.input, '/api/trash/file%2Fid')
    assert.equal(request.init.method, 'DELETE')
  } finally {
    restore()
  }
})

test('purge folder loops until remaining reaches 0 and reports progress', async () => {
  const calls = []
  const responses = [
    { purged: 40, remaining: 5 },
    { purged: 5, remaining: 0 },
  ]
  const progress = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return new Response(JSON.stringify(responses[calls.length - 1]), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const result = await purgeTrashItem('folder/id', (done) => progress.push(done))
    assert.deepEqual(result, { purged: 45, remaining: 0 })
    assert.deepEqual(progress, [40, 45])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].input, '/api/trash/folder%2Fid')
    assert.equal(calls[1].init.method, 'DELETE')
  } finally {
    globalThis.fetch = original
  }
})

test('empty loops until remaining reaches 0', async () => {
  const calls = []
  const responses = [
    { purged: 40, remaining: 40 },
    { purged: 3, remaining: 0 },
  ]
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return new Response(JSON.stringify(responses[calls.length - 1]), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    assert.deepEqual(await emptyTrash(), { purged: 43, remaining: 0 })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].init.method, 'DELETE')
    assert.equal(calls[1].input, '/api/trash')
  } finally {
    globalThis.fetch = original
  }
})
