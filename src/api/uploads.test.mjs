import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelUpload, createUpload, getUploadProgress, uploadChunk, UploadsRequestError } from './uploads.ts'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function driveItem() {
  return {
    id: 'f1',
    parent_id: null,
    kind: 'file',
    name: 'x.bin',
    size_bytes: 200,
    mime_type: 'application/octet-stream',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    enc: 1,
    wrappedKey: 'wrapped',
  }
}

function mockFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = { input, init }
    calls.push(request)
    return handler(request)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

function offsetOf(request) {
  return Number(new URL(request.input, 'http://cloudhub.test').searchParams.get('offset'))
}

test('createUpload posts the encrypted upload fields', async () => {
  let request
  const restore = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    request = { input, init }
    return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
  }
  try {
    const result = await createUpload({
      id: 'f1',
      parentId: 'parent/id',
      encName: 'enc',
      nameKey: 'nk',
      wrappedKey: 'wk',
      size: 33554460,
    })
    assert.equal(request.input, '/api/uploads')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), {
      id: 'f1',
      parentId: 'parent/id',
      encName: 'enc',
      nameKey: 'nk',
      wrappedKey: 'wk',
      size: 33554460,
    })
    assert.deepEqual(result, { uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 })
  } finally {
    globalThis.fetch = restore
  }
})

test('createUpload surfaces an id_conflict error', async () => {
  const { restore } = mockFetch(() => json({ error: 'id_conflict' }, 409))
  try {
    await assert.rejects(
      () => createUpload({ id: 'f1', parentId: null, encName: 'enc', nameKey: 'nk', wrappedKey: 'wk', size: 28 }),
      (error) => error instanceof UploadsRequestError && error.status === 409 && error.code === 'id_conflict',
    )
  } finally {
    restore()
  }
})

test('uploadChunk puts the chunk at the cipher offset and returns the result', async () => {
  const item = driveItem()
  const { calls, restore } = mockFetch((request) => {
    if (offsetOf(request) === 33554432) return json({ receivedBytes: 33554460, done: true, item })
    return json({ receivedBytes: 33554432, done: false })
  })
  try {
    const first = await uploadChunk('u1', 0, new Blob([new Uint8Array(28)]))
    assert.equal(offsetOf(calls[0]), 0)
    assert.equal(calls[0].init.method, 'PUT')
    assert.deepEqual(first, { receivedBytes: 33554432, done: false, item: undefined })
    const second = await uploadChunk('u1', 33554432, new Blob([new Uint8Array(28)]))
    assert.equal(offsetOf(calls[1]), 33554432)
    assert.deepEqual(second, { receivedBytes: 33554460, done: true, item })
  } finally {
    restore()
  }
})

test('uploadChunk surfaces receivedBytes on offset_mismatch', async () => {
  const { restore } = mockFetch(() => json({ error: 'offset_mismatch', receivedBytes: 67108864 }, 409))
  try {
    await assert.rejects(
      () => uploadChunk('u1', 0, new Blob([new Uint8Array(28)])),
      (error) => error instanceof UploadsRequestError
        && error.status === 409
        && error.code === 'offset_mismatch'
        && error.receivedBytes === 67108864,
    )
  } finally {
    restore()
  }
})

test('getUploadProgress parses the progress fields', async () => {
  const { restore } = mockFetch(() => json({ receivedBytes: 33554432, total: 33554460, done: false }))
  try {
    assert.deepEqual(await getUploadProgress('u1'), { receivedBytes: 33554432, total: 33554460, done: false })
  } finally {
    restore()
  }
})

test('cancelUpload deletes the session', async () => {
  let method
  const { restore } = mockFetch((request) => {
    method = request.init.method
    return json({ ok: true })
  })
  try {
    await cancelUpload('u1')
    assert.equal(method, 'DELETE')
  } finally {
    restore()
  }
})

test('createUpload parses storage_full required and largestAvailable from a 507', async () => {
  const { restore } = mockFetch(() => json({ error: 'storage_full', required: 500, largestAvailable: 100 }, 507))
  try {
    await assert.rejects(
      () => createUpload({ id: 'f1', parentId: null, encName: 'enc', nameKey: 'nk', wrappedKey: 'wk', size: 500 }),
      (error) => error instanceof UploadsRequestError
        && error.status === 507
        && error.code === 'storage_full'
        && error.required === 500
        && error.largestAvailable === 100,
    )
  } finally {
    restore()
  }
})
