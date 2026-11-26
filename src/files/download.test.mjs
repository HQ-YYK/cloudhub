import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CIPHER_CHUNK_SIZE, encryptChunk, generateFileKey } from '../crypto/index.ts'
import {
  cipherSegments,
  DownloadError,
  downloadEncryptedFile,
  SEGMENT_SIZE,
  streamDecryptedChunks,
  verifyPlainTotal,
} from './download.ts'

function readableOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function mockDocument() {
  const original = globalThis.document
  const state = { clicked: false }
  globalThis.document = {
    body: { append() {} },
    createElement() {
      return {
        set href(_) {},
        set download(_) {},
        click() { state.clicked = true },
        remove() {},
      }
    },
  }
  return { state, restore: () => { globalThis.document = original } }
}

function spyUrlMethod(name, impl) {
  const descriptor = Object.getOwnPropertyDescriptor(URL, name)
  Object.defineProperty(URL, name, { configurable: true, writable: true, value: impl })
  return () => {
    if (descriptor) Object.defineProperty(URL, name, descriptor)
    else delete URL[name]
  }
}

test('cipherSegments splits a full 32MiB chunk into 4MiB segments', () => {
  const segments = cipherSegments(0, CIPHER_CHUNK_SIZE, SEGMENT_SIZE)
  assert.equal(segments.length, 8)
  assert.deepEqual(segments[0], { start: 0, end: SEGMENT_SIZE })
  assert.deepEqual(segments[7], { start: 7 * SEGMENT_SIZE, end: CIPHER_CHUNK_SIZE })
})

test('cipherSegments keeps the last segment short and handles an exact fit', () => {
  assert.deepEqual(cipherSegments(0, SEGMENT_SIZE, SEGMENT_SIZE), [{ start: 0, end: SEGMENT_SIZE }])
  assert.deepEqual(cipherSegments(0, SEGMENT_SIZE + 5, SEGMENT_SIZE), [
    { start: 0, end: SEGMENT_SIZE },
    { start: SEGMENT_SIZE, end: SEGMENT_SIZE + 5 },
  ])
})

test('streamDecryptedChunks decrypts and writes chunks in order', async () => {
  const fk = generateFileKey()
  const fileId = 'f1'
  const plain = new TextEncoder().encode('hello cloudhub ordered download')
  const cipherBytes = await encryptChunk(fk, fileId, 0, true, plain)
  const written = []
  await streamDecryptedChunks({
    fk,
    fileId,
    cipherSize: cipherBytes.length,
    fetchRange: async (start, end) => readableOf(cipherBytes.slice(start, end)),
    onProgress: () => {},
    signal: new AbortController().signal,
    segmentSize: 10,
    maxConcurrentSegments: 3,
    sink: async (chunk, index) => { written.push({ index, bytes: [...chunk] }) },
  })
  assert.equal(written.length, 1)
  assert.equal(written[0].index, 0)
  assert.deepEqual(written[0].bytes, [...plain])
})

test('streamDecryptedChunks reassembles out-of-order segments correctly', async () => {
  const fk = generateFileKey()
  const fileId = 'f2'
  const plain = new TextEncoder().encode('x'.repeat(100))
  const cipherBytes = await encryptChunk(fk, fileId, 0, true, plain)
  const segmentSize = 25
  const segments = cipherSegments(0, cipherBytes.length, segmentSize)
  // Later segments resolve first, so the concurrent workers finish out of order.
  const delays = segments.map((_, index) => (segments.length - index) * 10)
  const fetchRange = async (start, end) => {
    const index = segments.findIndex((segment) => segment.start === start && segment.end === end)
    const bytes = cipherBytes.slice(start, end)
    return new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(bytes)
          controller.close()
        }, delays[index])
      },
    })
  }
  const written = []
  await streamDecryptedChunks({
    fk,
    fileId,
    cipherSize: cipherBytes.length,
    fetchRange,
    onProgress: () => {},
    signal: new AbortController().signal,
    segmentSize,
    maxConcurrentSegments: segments.length,
    sink: async (chunk) => { written.push([...chunk]) },
  })
  assert.equal(written.length, 1)
  assert.deepEqual(written[0], [...plain])
})

test('streamDecryptedChunks retries a segment that stalls', async () => {
  const fk = generateFileKey()
  const fileId = 'f3'
  const plain = new TextEncoder().encode('stalled segment retry')
  const cipherBytes = await encryptChunk(fk, fileId, 0, true, plain)
  let calls = 0
  const fetchRange = async (start, end) => {
    calls += 1
    if (calls === 1) return new ReadableStream({ start() {} })
    return readableOf(cipherBytes.slice(start, end))
  }
  const written = []
  await streamDecryptedChunks({
    fk,
    fileId,
    cipherSize: cipherBytes.length,
    fetchRange,
    onProgress: () => {},
    signal: new AbortController().signal,
    segmentSize: cipherBytes.length,
    maxConcurrentSegments: 1,
    segmentIdleTimeoutMs: 20,
    segmentRetryDelays: [5],
    segmentAttempts: 2,
    sink: async (chunk) => { written.push([...chunk]) },
  })
  assert.equal(calls, 2)
  assert.deepEqual(written[0], [...plain])
})

test('streamDecryptedChunks retries a short segment and recovers', async () => {
  const fk = generateFileKey()
  const fileId = 'f4'
  const plain = new TextEncoder().encode('short segment retry')
  const cipherBytes = await encryptChunk(fk, fileId, 0, true, plain)
  let calls = 0
  const fetchRange = async (start, end) => {
    calls += 1
    const bytes = cipherBytes.slice(start, end)
    if (calls === 1) return readableOf(bytes.slice(0, Math.floor(bytes.length / 2)))
    return readableOf(bytes)
  }
  const written = []
  await streamDecryptedChunks({
    fk,
    fileId,
    cipherSize: cipherBytes.length,
    fetchRange,
    onProgress: () => {},
    signal: new AbortController().signal,
    segmentSize: cipherBytes.length,
    maxConcurrentSegments: 1,
    segmentRetryDelays: [0],
    segmentAttempts: 2,
    sink: async (chunk) => { written.push([...chunk]) },
  })
  assert.equal(calls, 2)
  assert.deepEqual(written[0], [...plain])
})

test('streamDecryptedChunks reports corruption only after exhausting chunk attempts', async () => {
  const fk = generateFileKey()
  const fileId = 'f5'
  const cipherSize = 100
  let fetches = 0
  const fetchRange = async (start, end) => {
    fetches += 1
    return readableOf(new Uint8Array(end - start).fill(7))
  }
  await assert.rejects(
    () => streamDecryptedChunks({
      fk,
      fileId,
      cipherSize,
      fetchRange,
      onProgress: () => {},
      signal: new AbortController().signal,
      attempts: 3,
      segmentSize: cipherSize,
      sink: async () => {},
    }),
    (error) => error instanceof DownloadError && error.code === 'decrypt_failed',
  )
  assert.equal(fetches, 3)
})

test('verifyPlainTotal throws incomplete when the totals do not match', () => {
  assert.throws(
    () => verifyPlainTotal(5, 10),
    (error) => error instanceof DownloadError && error.code === 'incomplete',
  )
  assert.doesNotThrow(() => verifyPlainTotal(10, 10))
})

test('downloadEncryptedFile delays revokeObjectURL past the save tick', async (t) => {
  const doc = mockDocument()
  let created = 0
  let revoked = 0
  const restoreCreate = spyUrlMethod('createObjectURL', () => { created += 1; return 'blob:fake' })
  const restoreRevoke = spyUrlMethod('revokeObjectURL', () => { revoked += 1 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fk = generateFileKey()
    const fileId = 'f6'
    const plain = new TextEncoder().encode('delayed revoke')
    const cipherBytes = await encryptChunk(fk, fileId, 0, true, plain)
    await downloadEncryptedFile({
      fk,
      fileId,
      cipherSize: cipherBytes.length,
      fileName: 'a.txt',
      fetchRange: async (start, end) => readableOf(cipherBytes.slice(start, end)),
      onProgress: () => {},
      signal: new AbortController().signal,
    })
    assert.equal(doc.state.clicked, true)
    assert.equal(created, 1)
    assert.equal(revoked, 0)
    t.mock.timers.tick(60000)
    assert.equal(revoked, 1)
  } finally {
    t.mock.timers.reset()
    restoreCreate()
    restoreRevoke()
    doc.restore()
  }
})

test('downloadEncryptedFile does not save when the download fails', async () => {
  const doc = mockDocument()
  let created = 0
  let revoked = 0
  const restoreCreate = spyUrlMethod('createObjectURL', () => { created += 1; return 'blob:fake' })
  const restoreRevoke = spyUrlMethod('revokeObjectURL', () => { revoked += 1 })
  try {
    const fk = generateFileKey()
    const fileId = 'f7'
    const cipherSize = 100
    const fetchRange = async (start, end) => readableOf(new Uint8Array(end - start).fill(7))
    await assert.rejects(
      () => downloadEncryptedFile({
        fk,
        fileId,
        cipherSize,
        fileName: 'bad.txt',
        fetchRange,
        onProgress: () => {},
        signal: new AbortController().signal,
        attempts: 1,
      }),
      (error) => error instanceof DownloadError && error.code === 'decrypt_failed',
    )
    assert.equal(created, 0)
    assert.equal(revoked, 0)
    assert.equal(doc.state.clicked, false)
  } finally {
    restoreCreate()
    restoreRevoke()
    doc.restore()
  }
})
