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

export const DEFAULT_RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000, 30000]
const MAX_RETRY_AFTER_SECONDS = 60

export type UploadSession = {
  id: string
  fk: Uint8Array<ArrayBuffer>
  uploadId: string
  parentId: string | null
  plainSize: number
  cipherSize: number
  encName: string
  nameKey: string
  wrappedKey: string
}

export class UploadPausedError extends Error {
  readonly session: UploadSession

  constructor(session: UploadSession) {
    super('upload_paused')
    this.name = 'UploadPausedError'
    this.session = session
  }
}

export function isRetryable(error: unknown): boolean {
  if (!(error instanceof UploadsRequestError)) return false
  if (error.status === 0 || error.status === 408 || error.status === 429) return true
  return error.status >= 500
}

export function retryDelayFor(error: unknown, retryDelays: number[], attempt: number): number {
  if (error instanceof UploadsRequestError && error.retryAfter !== null && error.retryAfter >= 0) {
    return Math.min(error.retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000
  }
  return retryDelays[attempt - 1] ?? 1000
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

export async function uploadEncryptedFile(
  file: File,
  parentId: string | null,
  mk: Uint8Array<ArrayBuffer>,
  options: {
    onProgress?: (receivedPlainBytes: number, totalPlainBytes: number) => void
    onRetry?: (attempt: number) => void
    signal?: AbortSignal
    retryDelays?: number[]
    resume?: UploadSession | null
  } = {},
): Promise<DriveItem | null> {
  const { onProgress, onRetry, signal, retryDelays = DEFAULT_RETRY_DELAYS, resume = null } = options
  if (signal?.aborted) return abortUpload(null)

  let session: UploadSession
  if (resume) {
    session = resume
  } else {
    const name = normalizeName(file.name)
    const id = crypto.randomUUID()
    const fk = generateFileKey()
    const plainSize = file.size
    const encName = await encryptFileMeta(fk, id, { name, mimeType: file.type || null })
    const nameKey = await nameKeyForName(mk, name)
    const wrappedKey = await wrapFileKey(fk, mk, id)
    const size = cipherSize(plainSize)
    const created = await createUpload({ id, parentId, encName, nameKey, wrappedKey, size })
    session = {
      id,
      fk,
      uploadId: created.uploadId,
      parentId,
      plainSize,
      cipherSize: size,
      encName,
      nameKey,
      wrappedKey,
    }
  }

  let plainOffset = 0
  let consecutiveFailures = 0

  const report = () => onProgress?.(plainOffset, session.plainSize)

  while (true) {
    if (signal?.aborted) return abortUpload(session.uploadId)

    const chunkIndex = Math.floor(plainOffset / PLAIN_CHUNK_SIZE)
    const { start, end, isLast } = plainChunkRange(session.plainSize, chunkIndex)
    const plainBytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
    const cipherBytes = await encryptChunk(session.fk, session.id, chunkIndex, isLast, plainBytes)
    const cipherOffset = chunkIndex * CIPHER_CHUNK_SIZE

    let result
    try {
      result = await uploadChunk(session.uploadId, cipherOffset, new Blob([cipherBytes]), signal, (sentBytes) => {
        const withinChunk = Math.max(0, Math.min(sentBytes, cipherBytes.length) - 28)
        onProgress?.(plainOffset + Math.min(withinChunk, end - start), session.plainSize)
      })
    } catch (error) {
      if (error instanceof UploadsRequestError && error.code === 'aborted') return abortUpload(session.uploadId)
      if (error instanceof UploadsRequestError && error.code === 'offset_mismatch') {
        if (typeof error.receivedBytes !== 'number') throw error
        plainOffset = plainOffsetFromCipherReceived(error.receivedBytes, session.plainSize)
        consecutiveFailures = 0
        report()
        continue
      }
      if (!isRetryable(error)) throw error

      consecutiveFailures += 1
      if (consecutiveFailures > retryDelays.length) throw new UploadPausedError(session)

      let progress
      try {
        progress = await getUploadProgress(session.uploadId)
      } catch {
        progress = null
      }
      if (progress) {
        if (progress.done) return null
        plainOffset = plainOffsetFromCipherReceived(progress.receivedBytes, session.plainSize)
      }
      onRetry?.(consecutiveFailures)
      await sleep(retryDelayFor(error, retryDelays, consecutiveFailures), signal)
      continue
    }

    consecutiveFailures = 0
    plainOffset += end - start
    report()
    if (result.done) return result.item ?? null
  }
}
