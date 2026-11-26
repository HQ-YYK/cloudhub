import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateMasterKey } from '../crypto/index.ts'
import { UploadsRequestError } from '../api/uploads.ts'
import { DEFAULT_RETRY_DELAYS, isRetryable, retryDelayFor, uploadEncryptedFile, UploadPausedError } from './upload.ts'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = { input, init, method: init?.method ?? 'GET' }
    calls.push(request)
    return handler(request)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

function makeFile(size = 100) {
  return new File([new Uint8Array(size)], 'a.bin', { type: 'application/octet-stream' })
}

test('isRetryable covers network errors, 408, 429 and every 5xx', () => {
  for (const status of [0, 408, 429, 500, 502, 503, 524]) {
    assert.equal(isRetryable(new UploadsRequestError(status, 'x')), true, `status ${status} should retry`)
  }
  for (const status of [400, 401, 404, 409]) {
    assert.equal(isRetryable(new UploadsRequestError(status, 'x')), false, `status ${status} should not retry`)
  }
  assert.equal(isRetryable(new Error('x')), false)
})

test('retryDelayFor uses the backoff schedule and honors Retry-After up to 60s', () => {
  assert.deepEqual(DEFAULT_RETRY_DELAYS, [2000, 5000, 10000, 20000, 30000, 30000])
  assert.equal(retryDelayFor(new UploadsRequestError(503, 'x'), DEFAULT_RETRY_DELAYS, 1), 2000)
  assert.equal(retryDelayFor(new UploadsRequestError(503, 'x', null, null, null, 3), DEFAULT_RETRY_DELAYS, 1), 3000)
  assert.equal(retryDelayFor(new UploadsRequestError(503, 'x', null, null, null, 999), DEFAULT_RETRY_DELAYS, 1), 60000)
  assert.equal(retryDelayFor(new UploadsRequestError(503, 'x', null, null, null, 0), DEFAULT_RETRY_DELAYS, 1), 0)
})

test('uploadEncryptedFile pauses after six retries without cancelling the session', async () => {
  const mk = generateMasterKey()
  const file = makeFile()
  let puts = 0
  let deletes = 0
  const { restore } = mockFetch((request) => {
    if (request.method === 'POST') return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.method === 'GET') return json({ receivedBytes: 0, total: 128, done: false })
    if (request.method === 'PUT') {
      puts += 1
      return json({ error: 'storage_unavailable' }, 503)
    }
    if (request.method === 'DELETE') {
      deletes += 1
      return json({ ok: true })
    }
    throw new Error(`unexpected ${request.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      () => uploadEncryptedFile(file, null, mk, { retryDelays: [0, 0, 0, 0, 0, 0] }),
      (error) => error instanceof UploadPausedError && error.session.uploadId === 'u1',
    )
    assert.equal(puts, 7)
    assert.equal(deletes, 0)
  } finally {
    restore()
  }
})

test('uploadEncryptedFile resumes from the saved session without recreating it', async () => {
  const mk = generateMasterKey()
  const file = makeFile()
  const item = {
    id: 'f1',
    parent_id: null,
    kind: 'file',
    name: 'enc',
    size_bytes: 128,
    mime_type: 'application/octet-stream',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    enc: 1,
    wrappedKey: 'wk',
  }
  const session = {
    id: 'f1',
    fk: new Uint8Array(32).fill(7),
    uploadId: 'u1',
    parentId: null,
    plainSize: 100,
    cipherSize: 128,
    encName: 'enc',
    nameKey: 'nk',
    wrappedKey: 'wk',
  }
  let posts = 0
  let putUrl = ''
  const { restore } = mockFetch((request) => {
    if (request.method === 'POST') {
      posts += 1
      return json({ uploadId: 'u2', chunkSize: 33554432, receivedBytes: 0 }, 201)
    }
    if (request.method === 'PUT') {
      putUrl = request.input
      return json({ receivedBytes: 128, done: true, item })
    }
    throw new Error(`unexpected ${request.method} ${request.input}`)
  })
  try {
    const result = await uploadEncryptedFile(file, null, mk, { resume: session })
    assert.equal(posts, 0)
    assert.ok(putUrl.includes('/u1/'), `expected u1 upload id, got ${putUrl}`)
    assert.deepEqual(result, item)
  } finally {
    restore()
  }
})

test('uploadEncryptedFile pauses on user abort without cancelling the session', async () => {
  const mk = generateMasterKey()
  const file = makeFile()
  const controller = new AbortController()
  let deletes = 0
  const { restore } = mockFetch((request) => {
    if (request.method === 'POST') return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.method === 'PUT') {
      controller.abort('pause')
      return json({ receivedBytes: 128, done: false })
    }
    if (request.method === 'DELETE') {
      deletes += 1
      return json({ ok: true })
    }
    throw new Error(`unexpected ${request.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      () => uploadEncryptedFile(file, null, mk, { signal: controller.signal }),
      (error) => error instanceof UploadPausedError
        && error.pauseReason === 'user'
        && error.session.uploadId === 'u1'
        && error.session.fk instanceof Uint8Array
        && error.session.fk.length === 32,
    )
    assert.equal(deletes, 0)
  } finally {
    restore()
  }
})

test('uploadEncryptedFile resumes a user-paused session with the same upload id and file key', async () => {
  const mk = generateMasterKey()
  const file = makeFile()
  const item = {
    id: 'f1',
    parent_id: null,
    kind: 'file',
    name: 'enc',
    size_bytes: 128,
    mime_type: 'application/octet-stream',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    enc: 1,
    wrappedKey: 'wk',
  }
  let phase = 'pause'
  const controller = new AbortController()
  let session = null
  const { calls, restore } = mockFetch((request) => {
    if (request.method === 'POST') return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.method === 'PUT') {
      if (phase === 'pause') {
        controller.abort('pause')
        return json({ receivedBytes: 128, done: false })
      }
      return json({ receivedBytes: 128, done: true, item })
    }
    throw new Error(`unexpected ${request.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      () => uploadEncryptedFile(file, null, mk, { signal: controller.signal }),
      (error) => {
        if (!(error instanceof UploadPausedError)) return false
        session = error.session
        return error.pauseReason === 'user'
      },
    )
    phase = 'resume'
    const result = await uploadEncryptedFile(file, null, mk, { resume: session })
    assert.deepEqual(result, item)
    const puts = calls.filter((call) => call.method === 'PUT')
    assert.ok(puts.every((call) => call.input.includes('/u1/')), 'resume should reuse the paused upload id')
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1, 'resume must not recreate the session or file key')
  } finally {
    restore()
  }
})

test('uploadEncryptedFile cancels the server session on user cancel', async () => {
  const mk = generateMasterKey()
  const file = makeFile()
  const controller = new AbortController()
  let deletes = 0
  const { restore } = mockFetch((request) => {
    if (request.method === 'POST') return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    if (request.method === 'PUT') {
      controller.abort()
      return json({ receivedBytes: 128, done: false })
    }
    if (request.method === 'DELETE') {
      deletes += 1
      return json({ ok: true })
    }
    throw new Error(`unexpected ${request.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      () => uploadEncryptedFile(file, null, mk, { signal: controller.signal }),
      (error) => error instanceof UploadsRequestError && error.code === 'aborted',
    )
    assert.equal(deletes, 1)
  } finally {
    restore()
  }
})

test('uploadEncryptedFile pauses after createUpload returns when aborted during creation', async () => {
  const mk = generateMasterKey()
  const file = makeFile()
  const controller = new AbortController()
  let deletes = 0
  const { restore } = mockFetch((request) => {
    if (request.method === 'POST') {
      controller.abort('pause')
      return json({ uploadId: 'u1', chunkSize: 33554432, receivedBytes: 0 }, 201)
    }
    if (request.method === 'DELETE') {
      deletes += 1
      return json({ ok: true })
    }
    throw new Error(`unexpected ${request.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      () => uploadEncryptedFile(file, null, mk, { signal: controller.signal }),
      (error) => error instanceof UploadPausedError
        && error.pauseReason === 'user'
        && error.session.uploadId === 'u1'
        && error.session.fk instanceof Uint8Array
        && error.session.fk.length === 32,
    )
    assert.equal(deletes, 0)
  } finally {
    restore()
  }
})
