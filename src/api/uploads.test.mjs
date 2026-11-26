import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelUpload, createUpload, getUploadProgress, uploadChunk, UploadsRequestError } from './uploads.ts'
import { isRetryable, retryDelayFor, UploadPausedError, uploadEncryptedFile } from '../files/upload.ts'

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

test('createUpload maps a 429 non-JSON response to platform_limited', async () => {
  const { restore } = mockFetch(() => new Response('<html>rate limited</html>', {
    status: 429,
    headers: { 'Content-Type': 'text/html' },
  }))
  try {
    await assert.rejects(
      () => createUpload({ id: 'f1', parentId: null, encName: 'enc', nameKey: 'nk', wrappedKey: 'wk', size: 28 }),
      (error) => error instanceof UploadsRequestError && error.status === 429 && error.code === 'platform_limited',
    )
  } finally {
    restore()
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

test('uploadChunk surfaces Retry-After seconds on a 429', async () => {
  const { restore } = mockFetch(() => new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
  }))
  try {
    await assert.rejects(
      () => uploadChunk('u1', 0, new Blob([new Uint8Array(28)])),
      (error) => error instanceof UploadsRequestError
        && error.status === 429
        && error.code === 'rate_limited'
        && error.retryAfter === 7,
    )
  } finally {
    restore()
  }
})

test('isRetryable accepts network errors, throttling and all 5xx responses', () => {
  for (const status of [0, 408, 429, 500, 502, 503, 524]) {
    assert.equal(isRetryable(new UploadsRequestError(status, 'x')), true, `status ${status}`)
  }
  for (const status of [400, 401, 403, 404, 409]) {
    assert.equal(isRetryable(new UploadsRequestError(status, 'x')), false, `status ${status}`)
  }
  assert.equal(isRetryable(new Error('x')), false)
})

test('retryDelayFor honors Retry-After and caps it at 60 seconds', () => {
  assert.equal(retryDelayFor(new UploadsRequestError(429, 'x', null, null, null, 3), [2000, 5000], 1), 3000)
  assert.equal(retryDelayFor(new UploadsRequestError(503, 'x', null, null, null, 120), [2000, 5000], 1), 60000)
  assert.equal(retryDelayFor(new UploadsRequestError(502, 'x'), [2000, 5000], 2), 5000)
  assert.equal(retryDelayFor(new Error('x'), [2000, 5000], 1), 2000)
})

test('uploadEncryptedFile retries retryable statuses before succeeding', async () => {
  const item = driveItem()
  let chunkCalls = 0
  const { restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.init.method === 'GET') return json({ receivedBytes: 0, total: 44, done: false })
    chunkCalls += 1
    if (chunkCalls === 1) return json({ error: 'bad_gateway' }, 502)
    if (chunkCalls === 2) return json({ error: 'timeout' }, 524)
    if (chunkCalls === 3) return json({ error: 'rate_limited' }, 429)
    return json({ receivedBytes: 44, done: true, item })
  })
  try {
    const file = new File([new Uint8Array(16)], 'a.bin', { type: 'application/octet-stream' })
    const result = await uploadEncryptedFile(file, null, new Uint8Array(32).fill(1), { retryDelays: [1, 1, 1, 1, 1, 1] })
    assert.equal(chunkCalls, 4)
    assert.equal(result.id, item.id)
  } finally {
    restore()
  }
})

test('uploadEncryptedFile pauses after exhausting retries without canceling', async () => {
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.init.method === 'GET') return json({ receivedBytes: 0, total: 44, done: false })
    if (request.init.method === 'DELETE') return json({ ok: true })
    return json({ error: 'bad_gateway' }, 502)
  })
  try {
    const file = new File([new Uint8Array(16)], 'a.bin', { type: 'application/octet-stream' })
    await assert.rejects(
      () => uploadEncryptedFile(file, null, new Uint8Array(32).fill(1), { retryDelays: [1, 1, 1, 1, 1, 1] }),
      (error) => error instanceof UploadPausedError && error.session.uploadId === 'u1',
    )
    assert.equal(calls.filter((call) => call.init.method === 'PUT').length, 7)
    assert.equal(calls.some((call) => call.init.method === 'DELETE'), false)
  } finally {
    restore()
  }
})

test('uploadEncryptedFile resume reuses the saved upload id', async () => {
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'fresh', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.init.method === 'GET') return json({ receivedBytes: 0, total: 44, done: false })
    return json({ receivedBytes: 44, done: true, item: driveItem() })
  })
  try {
    const session = {
      id: 'file-1',
      fk: new Uint8Array(32).fill(2),
      uploadId: 'resume-id',
      parentId: null,
      plainSize: 16,
      cipherSize: 44,
      encName: 'enc',
      nameKey: 'nk',
      wrappedKey: 'wk',
    }
    const file = new File([new Uint8Array(16)], 'a.bin', { type: 'application/octet-stream' })
    await uploadEncryptedFile(file, null, new Uint8Array(32).fill(1), { resume: session })
    assert.equal(calls.some((call) => call.init.method === 'POST'), false)
    assert.ok(calls.some((call) => call.init.method === 'PUT' && call.input.includes('resume-id')))
  } finally {
    restore()
  }
})
