import {
  CIPHER_CHUNK_SIZE,
  PLAIN_CHUNK_SIZE,
  cipherSize,
  encryptChunk,
  encryptFileMeta,
  generateFileKey,
  wrapFileKey,
} from '../crypto/index.ts'
import { cancelUpload, createUpload, getUploadProgress, uploadChunk, UploadsRequestError } from '../api/uploads.ts'
import type { DriveItem } from '../api/files.ts'
import { plainChunkRange, plainOffsetFromCipherReceived } from './chunks.ts'
import { nameKeyForName } from './session.ts'
import { normalizeName } from './names.ts'

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000]

function isRetryable(error: unknown): boolean {
  if (!(error instanceof UploadsRequestError)) return false
  if (error.status === 0) return true
  if (error.status === 503) return true
  return error.status >= 500 && error.status !== 502
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    if (!signal) return
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function abortUpload(uploadId: string | null): Promise<never> {
  if (uploadId) await cancelUpload(uploadId).catch(() => {})
  throw new UploadsRequestError(0, 'aborted')
}

async function failUpload(uploadId: string, error: unknown): Promise<never> {
  await cancelUpload(uploadId).catch(() => {})
  throw error
}

export async function uploadEncryptedFile(
  file: File,
  parentId: string | null,
  mk: Uint8Array<ArrayBuffer>,
  options: {
    onProgress?: (receivedPlainBytes: number, totalPlainBytes: number) => void
    signal?: AbortSignal
    retryDelays?: number[]
  } = {},
): Promise<DriveItem | null> {
  const { onProgress, signal, retryDelays = DEFAULT_RETRY_DELAYS } = options
  if (signal?.aborted) return abortUpload(null)

  const name = normalizeName(file.name)
  const id = crypto.randomUUID()
  const fk = generateFileKey()
  const plainSize = file.size
  const encName = await encryptFileMeta(fk, id, { name, mimeType: file.type || null })
  const nameKey = await nameKeyForName(mk, name)
  const wrappedKey = await wrapFileKey(fk, mk, id)
  const size = cipherSize(plainSize)

  const created = await createUpload({ id, parentId, encName, nameKey, wrappedKey, size })
  let plainOffset = 0
  let consecutiveFailures = 0

  const report = () => onProgress?.(plainOffset, plainSize)

  while (true) {
    if (signal?.aborted) return abortUpload(created.uploadId)

    const chunkIndex = Math.floor(plainOffset / PLAIN_CHUNK_SIZE)
    const { start, end, isLast } = plainChunkRange(plainSize, chunkIndex)
    const plainBytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
    const cipherBytes = await encryptChunk(fk, id, chunkIndex, isLast, plainBytes)
    const cipherOffset = chunkIndex * CIPHER_CHUNK_SIZE

    let result
    try {
      result = await uploadChunk(created.uploadId, cipherOffset, new Blob([cipherBytes]), signal, (sentBytes) => {
        const withinChunk = Math.max(0, Math.min(sentBytes, cipherBytes.length) - 28)
        onProgress?.(plainOffset + Math.min(withinChunk, end - start), plainSize)
      })
    } catch (error) {
      if (error instanceof UploadsRequestError && error.code === 'aborted') return abortUpload(created.uploadId)
      if (error instanceof UploadsRequestError && error.code === 'offset_mismatch') {
        if (typeof error.receivedBytes !== 'number') return failUpload(created.uploadId, error)
        plainOffset = plainOffsetFromCipherReceived(error.receivedBytes, plainSize)
        consecutiveFailures = 0
        report()
        continue
      }
      if (!isRetryable(error)) return failUpload(created.uploadId, error)

      consecutiveFailures += 1
      if (consecutiveFailures >= 3) return failUpload(created.uploadId, error)

      let progress
      try {
        progress = await getUploadProgress(created.uploadId)
      } catch {
        progress = null
      }
      if (progress) {
        if (progress.done) return null
        plainOffset = plainOffsetFromCipherReceived(progress.receivedBytes, plainSize)
      }
      report()
      await sleep(retryDelays[consecutiveFailures - 1] ?? 1000, signal)
      continue
    }

    consecutiveFailures = 0
    plainOffset += end - start
    report()
    if (result.done) return result.item ?? null
  }
}
