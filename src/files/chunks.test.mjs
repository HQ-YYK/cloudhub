import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CIPHER_CHUNK_SIZE, PLAIN_CHUNK_SIZE } from '../crypto/index.ts'
import { UploadProgressError, chunkCipherRange, plainChunkRange, plainOffsetFromCipherReceived } from './chunks.ts'

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
