import { FilesRequestError, type DriveItem } from './files.ts'
import { classifyPlatformResponse } from '../utils/service-limits.ts'

export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024

export class UploadsRequestError extends FilesRequestError {
  readonly receivedBytes: number | null
  readonly required: number | null
  readonly largestAvailable: number | null
  readonly retryAfter: number | null

  constructor(
    status: number,
    code: string,
    receivedBytes: number | null = null,
    required: number | null = null,
    largestAvailable: number | null = null,
    retryAfter: number | null = null,
  ) {
    super(status, code)
    this.name = 'UploadsRequestError'
    this.receivedBytes = receivedBytes
    this.required = required
    this.largestAvailable = largestAvailable
    this.retryAfter = retryAfter
  }
}

export type CreateUploadInput = {
  id: string
  parentId: string | null
  encName: string
  nameKey: string
  wrappedKey: string
  size: number
}

type UploadResponse = {
  uploadId?: string
  chunkSize?: number
  receivedBytes?: number
  total?: number
  done?: boolean
  item?: DriveItem
  ok?: boolean
  error?: string
  required?: number
  largestAvailable?: number
}

type ChunkResult = {
  receivedBytes: number
  done: boolean
  item?: DriveItem
}

async function requestUploads(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<UploadResponse> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      signal,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch {
    if (signal?.aborted) throw new UploadsRequestError(0, 'aborted')
    throw new UploadsRequestError(0, 'network_error')
  }

  let payload: UploadResponse = {}
  let parseFailed = false
  try {
    payload = await response.json() as UploadResponse
  } catch {
    parseFailed = true
  }
  if (!response.ok) {
    const receivedBytes = typeof payload.receivedBytes === 'number' ? payload.receivedBytes : null
    const required = typeof payload.required === 'number' ? payload.required : null
    const largestAvailable = typeof payload.largestAvailable === 'number' ? payload.largestAvailable : null
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
    const code = parseFailed
      ? (classifyPlatformResponse(response.status, response.headers.get('Content-Type')) ?? 'request_failed')
      : (payload.error ?? 'request_failed')
    throw new UploadsRequestError(response.status, code, receivedBytes, required, largestAvailable, retryAfter)
  }
  return payload
}

// Retry-After is normally a non-negative integer number of seconds; HTTP-date
// forms are rare here and fall back to the caller's backoff schedule.
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null
  const text = value.trim()
  if (text === '' || !/^\d+$/u.test(text)) return null
  const seconds = Number(text)
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null
}

export async function createUpload(input: CreateUploadInput): Promise<{ uploadId: string; chunkSize: number; receivedBytes: number }> {
  const payload = await requestUploads('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      id: input.id,
      parentId: input.parentId,
      encName: input.encName,
      nameKey: input.nameKey,
      wrappedKey: input.wrappedKey,
      size: input.size,
    }),
  })
  if (typeof payload.uploadId !== 'string' || typeof payload.chunkSize !== 'number' || typeof payload.receivedBytes !== 'number') {
    throw new UploadsRequestError(500, 'invalid_response')
  }
  return { uploadId: payload.uploadId, chunkSize: payload.chunkSize, receivedBytes: payload.receivedBytes }
}

function parseErrorPayload(text: string): { payload: UploadResponse; failed: boolean } {
  try {
    return { payload: JSON.parse(text) as UploadResponse, failed: false }
  } catch {
    return { payload: {}, failed: true }
  }
}

const CHUNK_RESPONSE_TIMEOUT_MS = 120000

// fetch cannot report request body progress, so browsers use XHR for chunk bodies.
function sendChunkWithXhr(
  path: string,
  chunk: Blob,
  signal: AbortSignal | undefined,
  onChunkProgress: ((sentBytes: number) => void) | undefined,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadsRequestError(0, 'aborted'))
      return
    }
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    xhr.open('PUT', path)
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (event) => onChunkProgress?.(event.loaded)
    // Keep the request alive while the body is still uploading, then allow 120s
    // for the server to respond once the body has been fully sent.
    xhr.timeout = 0
    xhr.upload.onload = () => {
      xhr.timeout = CHUNK_RESPONSE_TIMEOUT_MS
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new UploadsRequestError(0, 'network_error'))
    }
    xhr.onload = () => {
      cleanup()
      const parsed = parseErrorPayload(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed.payload)
        return
      }
      const receivedBytes = typeof parsed.payload.receivedBytes === 'number' ? parsed.payload.receivedBytes : null
      const retryAfter = parseRetryAfter(xhr.getResponseHeader('Retry-After'))
      const code = parsed.failed
        ? (classifyPlatformResponse(xhr.status, xhr.getResponseHeader('Content-Type')) ?? 'request_failed')
        : (parsed.payload.error ?? 'request_failed')
      reject(new UploadsRequestError(xhr.status, code, receivedBytes, null, null, retryAfter))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new UploadsRequestError(0, 'network_error'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new UploadsRequestError(0, 'aborted'))
    }
    xhr.send(chunk)
  })
}

export async function uploadChunk(
  uploadId: string,
  offset: number,
  chunk: Blob,
  signal?: AbortSignal,
  onChunkProgress?: (sentBytes: number) => void,
): Promise<ChunkResult> {
  const path = `/api/uploads/${encodeURIComponent(uploadId)}/chunk?offset=${offset}`
  const payload = typeof XMLHttpRequest === 'undefined'
    ? await requestUploads(path, { method: 'PUT', body: chunk }, signal)
    : await sendChunkWithXhr(path, chunk, signal, onChunkProgress)
  if (typeof payload.receivedBytes !== 'number' || typeof payload.done !== 'boolean') {
    throw new UploadsRequestError(500, 'invalid_response')
  }
  return { receivedBytes: payload.receivedBytes, done: payload.done, item: payload.item }
}

export async function getUploadProgress(uploadId: string): Promise<{ receivedBytes: number; total: number; done: boolean }> {
  const payload = await requestUploads(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'GET' })
  if (typeof payload.receivedBytes !== 'number' || typeof payload.total !== 'number' || typeof payload.done !== 'boolean') {
    throw new UploadsRequestError(500, 'invalid_response')
  }
  return { receivedBytes: payload.receivedBytes, total: payload.total, done: payload.done }
}

export async function cancelUpload(uploadId: string): Promise<void> {
  await requestUploads(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
}
