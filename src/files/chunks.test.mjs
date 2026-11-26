import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CIPHER_CHUNK_SIZE, PLAIN_CHUNK_SIZE, cipherSize, encryptChunk } from '../crypto/index.ts'
import { UploadProgressError, chunkCipherRange, plainChunkRange, plainOffsetFromCipherReceived } from './chunks.ts'
import { DownloadError, cipherSegments, streamDecryptedChunks } from './download.ts'

test('plainOffsetFromCipherReceived converts a full chunk into a plain offset', () => {
  assert.equal(plainOffsetFromCipherReceived(CIPHER_CHUNK_SIZE, PLAIN_CHUNK_SIZE * 10), PLAIN_CHUNK_SIZE)
  assert.equal(plainOffsetFromCipherReceived(0, 123), 0)
})

test('plainOffsetFromCipherReceived caps at the plain size for the final chunk', () => {
  const plainSize = PLAIN_CHUNK_SIZE + 100
  assert.equal(plainOffsetFromCipherReceived(2 * CIPHER_CHUNK_SIZE, plainSize), plainSize)
})

test('plainOffsetFromCipherReceived rejects values that are not a whole chunk', () => {
  assert.throws(() => plainOffsetFromCipherReceived(CIPHER_CHUNK_SIZE + 1, 1000), UploadProgressError)
  assert.throws(() => plainOffsetFromCipherReceived(100, 1000), UploadProgressError)
  assert.throws(() => plainOffsetFromCipherReceived(-CIPHER_CHUNK_SIZE, 1000), UploadProgressError)
  assert.throws(() => plainOffsetFromCipherReceived(1.5, 1000), UploadProgressError)
})

test('plainChunkRange splits a multi-chunk file', () => {
  const plainSize = PLAIN_CHUNK_SIZE + 10
  assert.deepEqual(plainChunkRange(plainSize, 0), { start: 0, end: PLAIN_CHUNK_SIZE, isLast: false })
  assert.deepEqual(plainChunkRange(plainSize, 1), { start: PLAIN_CHUNK_SIZE, end: plainSize, isLast: true })
})

test('plainChunkRange treats an empty file as a single last chunk', () => {
  assert.deepEqual(plainChunkRange(0, 0), { start: 0, end: 0, isLast: true })
})

test('chunkCipherRange maps each chunk to its cipher range', () => {
  const cipherSize = CIPHER_CHUNK_SIZE + 38
  assert.deepEqual(chunkCipherRange(0, cipherSize), { start: 0, end: CIPHER_CHUNK_SIZE, isLast: false })
  assert.deepEqual(chunkCipherRange(1, cipherSize), { start: CIPHER_CHUNK_SIZE, end: cipherSize, isLast: true })
})

test('chunkCipherRange marks a single chunk as the last one', () => {
  assert.deepEqual(chunkCipherRange(0, CIPHER_CHUNK_SIZE), { start: 0, end: CIPHER_CHUNK_SIZE, isLast: true })
})

function delayedStream(bytes, delay) {
  return new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(bytes)
        controller.close()
      }, delay)
    },
  })
}

test('cipherSegments splits a full chunk and the final partial chunk', () => {
  const full = cipherSegments(0, CIPHER_CHUNK_SIZE)
  assert.equal(full.length, 8)
  assert.equal(full[0].start, 0)
  assert.equal(full[7].end, CIPHER_CHUNK_SIZE)
  for (const segment of full) assert.equal(segment.end - segment.start, 4 * 1024 * 1024)

  const last = cipherSegments(CIPHER_CHUNK_SIZE, CIPHER_CHUNK_SIZE + 38)
  assert.deepEqual(last, [{ start: CIPHER_CHUNK_SIZE, end: CIPHER_CHUNK_SIZE + 38 }])

  assert.deepEqual(cipherSegments(0, 48), [{ start: 0, end: 48 }])
})

test('cipherSegments covers a two-chunk file end to end', () => {
  const plainSize = PLAIN_CHUNK_SIZE + 10
  const total = cipherSize(plainSize)
  const first = cipherSegments(0, CIPHER_CHUNK_SIZE)
  const second = cipherSegments(CIPHER_CHUNK_SIZE, total)
  assert.equal(first.length, 8)
  assert.equal(second.length, 1)
  assert.equal(second[0].end, total)
})

test('streamDecryptedChunks reassembles out-of-order segments in order', async () => {
  const fk = new Uint8Array(32).fill(1)
  const fileId = 'f1'
  const plain = new TextEncoder().encode('hello out-of-order segments world')
  const cipher = await encryptChunk(fk, fileId, 0, true, plain)
  const cipherSize = cipher.length

  const fetchRange = async (start, end) => {
    const delay = Math.max(1, 60 - start)
    return delayedStream(cipher.slice(start, end), delay)
  }

  const received = []
  await streamDecryptedChunks({
    fk,
    fileId,
    cipherSize,
    fetchRange,
    onProgress: () => {},
    signal: new AbortController().signal,
    segmentSize: 4,
    segmentIdleTimeoutMs: 5000,
    sink: async (chunk) => { received.push(chunk) },
  })

  assert.equal(received.length, 1)
  assert.deepEqual([...received[0]], [...plain])
})

test('a stalled segment times out and succeeds on retry', async () => {
  const fk = new Uint8Array(32).fill(1)
  const fileId = 'f1'
  const plain = new TextEncoder().encode('recover after timeout')
  const cipher = await encryptChunk(fk, fileId, 0, true, plain)
  const cipherSize = cipher.length
  let calls = 0

  const fetchRange = async (start, end) => {
    calls += 1
    if (calls === 1) {
      return new ReadableStream({ start() { /* never enqueues; triggers the idle timeout */ } })
    }
    return delayedStream(cipher.slice(start, end), 0)
  }

  const received = []
  await streamDecryptedChunks({
    fk,
    fileId,
    cipherSize,
    fetchRange,
    onProgress: () => {},
    signal: new AbortController().signal,
    segmentSize: cipherSize,
    segmentIdleTimeoutMs: 20,
    segmentRetryDelays: [1, 1, 1, 1],
    sink: async (chunk) => { received.push(chunk) },
  })

  assert.equal(calls, 2)
  assert.deepEqual([...received[0]], [...plain])
})

test('decrypt failure is reported only after all chunk retries', async () => {
  const fk = new Uint8Array(32).fill(1)
  const fileId = 'f1'
  const plain = new TextEncoder().encode('corrupted payload')
  const cipher = await encryptChunk(fk, fileId, 0, true, plain)
  const cipherSize = cipher.length
  const garbage = new Uint8Array(cipher.length).fill(99)
  let calls = 0

  const fetchRange = async (start, end) => {
    calls += 1
    return delayedStream(garbage.slice(start, end), 0)
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
  assert.equal(calls, 3)
})
