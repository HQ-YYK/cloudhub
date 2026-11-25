import { CryptoError } from './encoding.ts'
import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from './keys.ts'

export const CIPHER_CHUNK_SIZE = 32 * 1024 * 1024
export const PLAIN_CHUNK_SIZE = CIPHER_CHUNK_SIZE - 28

export function chunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / PLAIN_CHUNK_SIZE))
}

export function cipherSize(plainSize: number): number {
  return plainSize + 28 * chunkCount(plainSize)
}

export function plainSizeFromCipher(cipherSize: number): number {
  if (!Number.isInteger(cipherSize) || cipherSize < 28) throw new CryptoError('invalid_size')
  const chunkTotal = Math.ceil(cipherSize / CIPHER_CHUNK_SIZE)
  const lastCipherLength = cipherSize - (chunkTotal - 1) * CIPHER_CHUNK_SIZE
  if (lastCipherLength < 28) throw new CryptoError('invalid_size')
  const lastPlainLength = lastCipherLength - 28
  if (lastPlainLength === 0 && chunkTotal > 1) throw new CryptoError('invalid_size')
  return (chunkTotal - 1) * PLAIN_CHUNK_SIZE + lastPlainLength
}

function chunkAad(fileId: string, index: number, isLast: boolean): string {
  return `cloudhub/v1/chunk:${fileId}:${index}:${isLast ? 1 : 0}`
}

export async function encryptChunk(
  fk: Uint8Array<ArrayBuffer>,
  fileId: string,
  index: number,
  isLast: boolean,
  plainBytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmEncrypt(await importAesGcmKey(fk), chunkAad(fileId, index, isLast), plainBytes)
}

export async function decryptChunk(
  fk: Uint8Array<ArrayBuffer>,
  fileId: string,
  index: number,
  isLast: boolean,
  cipherBytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmDecrypt(await importAesGcmKey(fk), chunkAad(fileId, index, isLast), cipherBytes)
}

// `end` is exclusive. The returned cipher range is also end-exclusive and never runs past the ciphertext.
export function cipherRangeForPlain(start: number, end: number, plainSize: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(plainSize)) {
    throw new CryptoError('invalid_input')
  }
  if (start < 0 || start >= end || end > plainSize) throw new CryptoError('invalid_input')
  const firstChunk = Math.floor(start / PLAIN_CHUNK_SIZE)
  const lastChunk = Math.floor((end - 1) / PLAIN_CHUNK_SIZE)
  return {
    firstChunk,
    lastChunk,
    cipherStart: firstChunk * CIPHER_CHUNK_SIZE,
    cipherEnd: Math.min((lastChunk + 1) * CIPHER_CHUNK_SIZE, cipherSize(plainSize)),
  }
}
