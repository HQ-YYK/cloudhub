import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UploadsRequestError, uploadFile } from './uploads.ts'

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
    mime_type: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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

test('uploads a file in two chunks and returns the item', async () => {
  const file = new File([new Uint8Array(200)], 'hello.bin', { type: 'application/octet-stream' })
  const item = driveItem()
  const progress = []
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 100, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      if (offsetOf(request) === 0) return json({ receivedBytes: 100, done: false })
      return json({ receivedBytes: 200, done: true, item })
    }
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    const result = await uploadFile(file, null, { onProgress: (received, total) => progress.push([received, total]) })
    assert.deepEqual(result, item)
    const puts = calls.filter((call) => call.init.method === 'PUT')
    assert.equal(puts.length, 2)
    assert.equal(offsetOf(puts[1]), 100)
    assert.equal(puts[1].init.body.size, 100)
    assert.ok(progress.length >= 2)
    assert.deepEqual(progress[progress.length - 1], [200, 200])
  } finally {
    restore()
  }
})

test('resumes from the server-reported receivedBytes when a chunk is partially accepted', async () => {
  const data = new Uint8Array(256)
  for (let index = 0; index < data.length; index += 1) data[index] = index % 256
  const file = new File([data], 'x.bin')
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 128, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      if (offsetOf(request) === 0) return json({ receivedBytes: 64, done: false })
      return json({ receivedBytes: 256, done: true, item: driveItem() })
    }
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    await uploadFile(file, null)
    const puts = calls.filter((call) => call.init.method === 'PUT')
    assert.equal(puts.length, 2)
    assert.equal(offsetOf(puts[1]), 64)
    const post = calls.find((call) => call.init.method === 'POST')
    assert.equal(JSON.parse(post.init.body).mimeType, null)
    const body = new Uint8Array(await puts[1].init.body.arrayBuffer())
    assert.equal(body.length, 128)
    assert.equal(body[0], 64)
  } finally {
    restore()
  }
})

test('continues from the receivedBytes in a 409 offset_mismatch without counting a failure', async () => {
  const file = new File([new Uint8Array(200)], 'x.bin')
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 100, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      if (offsetOf(request) === 0) return json({ error: 'offset_mismatch', receivedBytes: 150 }, 409)
      return json({ receivedBytes: 200, done: true, item: driveItem() })
    }
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    await uploadFile(file, null)
    const puts = calls.filter((call) => call.init.method === 'PUT')
    assert.equal(puts.length, 2)
    assert.equal(offsetOf(puts[1]), 150)
    assert.equal(calls.filter((call) => call.init.method === 'GET').length, 0)
  } finally {
    restore()
  }
})

test('recovers from a single 503 after reconciling progress via GET', async () => {
  const file = new File([new Uint8Array(200)], 'x.bin')
  let putCount = 0
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 100, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      putCount += 1
      if (putCount === 1) return json({ error: 'storage_unavailable' }, 503)
      return json({ receivedBytes: 200, done: true, item: driveItem() })
    }
    if (request.init.method === 'GET') return json({ receivedBytes: 0, total: 200, done: false })
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    const result = await uploadFile(file, null, { retryDelays: [1, 1, 1] })
    assert.deepEqual(result, driveItem())
    assert.equal(putCount, 2)
    assert.equal(calls.filter((call) => call.init.method === 'GET').length, 1)
  } finally {
    restore()
  }
})

test('gives up after three consecutive 503s', async () => {
  const file = new File([new Uint8Array(200)], 'x.bin')
  let putCount = 0
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 100, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      putCount += 1
      return json({ error: 'storage_unavailable' }, 503)
    }
    if (request.init.method === 'GET') return json({ receivedBytes: 0, total: 200, done: false })
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      uploadFile(file, null, { retryDelays: [1, 1, 1] }),
      (error) => error instanceof UploadsRequestError && error.status === 503,
    )
    assert.equal(putCount, 3)
    assert.equal(calls.filter((call) => call.init.method === 'GET').length, 2)
  } finally {
    restore()
  }
})

test('fails immediately on 410 without retrying', async () => {
  const file = new File([new Uint8Array(100)], 'x.bin')
  let putCount = 0
  const { calls, restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 100, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      putCount += 1
      return json({ error: 'upload_expired' }, 410)
    }
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    await assert.rejects(
      uploadFile(file, null, { retryDelays: [1, 1, 1] }),
      (error) => error instanceof UploadsRequestError && error.status === 410 && error.code === 'upload_expired',
    )
    assert.equal(putCount, 1)
    assert.equal(calls.filter((call) => call.init.method === 'GET').length, 0)
  } finally {
    restore()
  }
})

test('cancels the session and throws aborted when the signal fires', async () => {
  const file = new File([new Uint8Array(300)], 'x.bin')
  const controller = new AbortController()
  let deleted = false
  const { restore } = mockFetch((request) => {
    if (request.init.method === 'POST') return json({ uploadId: 'u1', chunkSize: 100, receivedBytes: 0 }, 201)
    if (request.init.method === 'PUT') {
      return new Promise((_resolve, reject) => {
        request.init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (request.init.method === 'DELETE') {
      deleted = true
      return json({ ok: true })
    }
    throw new Error(`unexpected request ${request.init.method} ${request.input}`)
  })
  try {
    const pending = uploadFile(file, null, { signal: controller.signal, retryDelays: [1, 1, 1] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await assert.rejects(
      pending,
      (error) => error instanceof UploadsRequestError && error.code === 'aborted',
    )
    assert.equal(deleted, true)
  } finally {
    restore()
  }
})
