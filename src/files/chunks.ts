import { CIPHER_CHUNK_SIZE, PLAIN_CHUNK_SIZE, chunkCount } from '../crypto/index.ts'

export class UploadProgressError extends Error {
  constructor() {
    super('upload_progress_invalid')
    this.name = 'UploadProgressError'
  }
}

export function plainOffsetFromCipherReceived(receivedBytes: number, plainSize: number): number {
  if (!Number.isInteger(receivedBytes) || receivedBytes < 0 || receivedBytes % CIPHER_CHUNK_SIZE !== 0) {
    throw new UploadProgressError()
  }
  const index = receivedBytes / CIPHER_CHUNK_SIZE
  return Math.min(index * PLAIN_CHUNK_SIZE, plainSize)
}

export function plainChunkRange(plainSize: number, index: number): { start: number; end: number; isLast: boolean } {
  const start = index * PLAIN_CHUNK_SIZE
  const end = Math.min(start + PLAIN_CHUNK_SIZE, plainSize)
  return { start, end, isLast: index === chunkCount(plainSize) - 1 }
}

export function chunkCipherRange(index: number, cipherSize: number): { start: number; end: number; isLast: boolean } {
  const start = index * CIPHER_CHUNK_SIZE
  const end = Math.min(start + CIPHER_CHUNK_SIZE, cipherSize)
  return { start, end, isLast: end >= cipherSize }
}
