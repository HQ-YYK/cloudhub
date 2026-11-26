import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShare, getPublicShare, listShares, listSharesByFile, revokeShare, SharesRequestError } from './shares.ts'

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

function shareView() {
  return {
    id: 'share/1',
    fileId: 'file/id',
    fileName: 'report.pdf',
    url: 'https://example.test/s/token',
    expiresAt: null,
    revokedAt: null,
    downloadCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    active: true,
  }
}

test('createShare posts the encoded file id and expiry', async () => {
  const share = shareView()
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ share }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await createShare('file/id', 7), share)
    assert.equal(request.input, '/api/files/file%2Fid/shares')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.init.body), { expiresInDays: 7 })
  } finally {
    restore()
  }
})

test('createShare sends null for a permanent link', async () => {
  const share = shareView()
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ share }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await createShare('file/id', null)
    assert.deepEqual(JSON.parse(request.init.body), { expiresInDays: null })
  } finally {
    restore()
  }
})

test('createShare surfaces the 409 too_many_shares code', async () => {
  const restore = mockFetch(
    new Response(JSON.stringify({ error: 'too_many_shares' }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    () => {},
  )
  try {
    await assert.rejects(
      () => createShare('file/id', 30),
      (error) => error instanceof SharesRequestError && error.status === 409 && error.code === 'too_many_shares',
    )
  } finally {
    restore()
  }
})

test('listSharesByFile returns the shares array', async () => {
  const shares = [shareView()]
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ shares }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await listSharesByFile('file/id'), shares)
    assert.equal(request.input, '/api/files/file%2Fid/shares')
    assert.equal(request.init.method, undefined)
    assert.equal(request.init.credentials, 'same-origin')
  } finally {
    restore()
  }
})

test('listShares lists all owned shares', async () => {
  const shares = [shareView()]
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ shares }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await listShares(), shares)
    assert.equal(request.input, '/api/shares')
  } finally {
    restore()
  }
})

test('revokeShare uses DELETE and the encoded share id', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ revoked: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await revokeShare('share/1')
    assert.equal(request.input, '/api/shares/share%2F1')
    assert.equal(request.init.method, 'DELETE')
    assert.equal(request.init.credentials, 'same-origin')
  } finally {
    restore()
  }
})

test('getPublicShare returns the metadata fields including the file id', async () => {
  const metadata = { enc: 1, encName: 'enc', sizeBytes: 1024, mimeType: 'application/octet-stream', expiresAt: null, id: 'file/id' }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await getPublicShare('token'), {
      enc: 1,
      encName: 'enc',
      name: null,
      sizeBytes: 1024,
      mimeType: 'application/octet-stream',
      expiresAt: null,
      id: 'file/id',
    })
    assert.equal(request.input, '/api/public/shares/token')
  } finally {
    restore()
  }
})

test('getPublicShare defaults enc to 0 and id to null for legacy metadata', async () => {
  const metadata = { name: 'report.pdf', sizeBytes: 1024, mimeType: 'application/pdf', expiresAt: null }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await getPublicShare('token'), {
      enc: 0,
      encName: null,
      name: 'report.pdf',
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      expiresAt: null,
      id: null,
    })
    assert.equal(request.input, '/api/public/shares/token')
  } finally {
    restore()
  }
})

test('getPublicShare surfaces a 404 not_found code', async () => {
  const restore = mockFetch(
    new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    () => {},
  )
  try {
    await assert.rejects(
      () => getPublicShare('missing'),
      (error) => error instanceof SharesRequestError && error.status === 404 && error.code === 'not_found',
    )
  } finally {
    restore()
  }
})
