import { FilesRequestError, type DriveItem } from './files.ts'

export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024

export class UploadsRequestError extends FilesRequestError {
  readonly receivedBytes: number | null
  readonly required: number | null
  readonly largestAvailable: number | null

  constructor(
    status: number,
    code: string,
    receivedBytes: number | null = null,
    required: number | null = null,
    largestAvailable: number | null = null,
  ) {
    super(status, code)
    this.name = 'UploadsRequestError'
    this.receivedBytes = receivedBytes
    this.required = required
    this.largestAvailable = largestAvailable
  }
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

  let payload: UploadResponse
  try {
    payload = await response.json() as UploadResponse
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const receivedBytes = typeof payload.receivedBytes === 'number' ? payload.receivedBytes : null
    const required = typeof payload.required === 'number' ? payload.required : null
    const largestAvailable = typeof payload.largestAvailable === 'number' ? payload.largestAvailable : null
    throw new UploadsRequestError(response.status, payload.error ?? 'request_failed', receivedBytes, required, largestAvailable)
  }
  return payload
}

export async function createUpload(
  parentId: string | null,
  name: string,
  size: number,
  mimeType: string | null,
): Promise<{ uploadId: string; chunkSize: number; receivedBytes: number }> {
  const payload = await requestUploads('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ parentId, name, size, mimeType }),
  })
  if (typeof payload.uploadId !== 'string' || typeof payload.chunkSize !== 'number' || typeof payload.receivedBytes !== 'number') {
    throw new UploadsRequestError(500, 'invalid_response')
  }
  return { uploadId: payload.uploadId, chunkSize: payload.chunkSize, receivedBytes: payload.receivedBytes }
}

function parseErrorPayload(text: string): UploadResponse {
  try {
    return JSON.parse(text) as UploadResponse
  } catch {
    return {}
  }
}

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
    xhr.onload = () => {
      cleanup()
      const payload = parseErrorPayload(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload)
        return
      }
      const receivedBytes = typeof payload.receivedBytes === 'number' ? payload.receivedBytes : null
      reject(new UploadsRequestError(xhr.status, payload.error ?? 'request_failed', receivedBytes))
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

// Release the pending record so the same name can be uploaded again.
async function failUpload(uploadId: string, error: unknown): Promise<never> {
  await cancelUpload(uploadId).catch(() => {})
  throw error
}

export async function uploadFile(
  file: File,
  parentId: string | null,
  options: {
    onProgress?: (receivedBytes: number, total: number) => void
    signal?: AbortSignal
    retryDelays?: number[]
  } = {},
): Promise<DriveItem | null> {
  const { onProgress, signal, retryDelays = DEFAULT_RETRY_DELAYS } = options

  if (signal?.aborted) return abortUpload(null)

  const created = await createUpload(parentId, file.name, file.size, file.type || null)
  let receivedBytes = created.receivedBytes
  let consecutiveFailures = 0

  const report = () => onProgress?.(receivedBytes, file.size)

  while (true) {
    if (signal?.aborted) return abortUpload(created.uploadId)

    const offset = receivedBytes
    const chunk = file.slice(offset, offset + created.chunkSize)

    let result: ChunkResult
    try {
      result = await uploadChunk(created.uploadId, offset, chunk, signal, (sentBytes) => {
        onProgress?.(offset + Math.min(sentBytes, chunk.size), file.size)
      })
    } catch (error) {
      if (error instanceof UploadsRequestError && error.code === 'aborted') return abortUpload(created.uploadId)
      if (error instanceof UploadsRequestError && error.code === 'offset_mismatch') {
        if (typeof error.receivedBytes !== 'number') return failUpload(created.uploadId, error)
        receivedBytes = error.receivedBytes
        consecutiveFailures = 0
        report()
        continue
      }
      if (!isRetryable(error)) return failUpload(created.uploadId, error)

      consecutiveFailures += 1
      if (consecutiveFailures >= 3) return failUpload(created.uploadId, error)

      try {
        const progress = await getUploadProgress(created.uploadId)
        if (progress.done) return null
        receivedBytes = progress.receivedBytes
      } catch {
        // Keep the last known offset and retry.
      }
      report()
      await sleep(retryDelays[consecutiveFailures - 1] ?? 1000, signal)
      continue
    }

    consecutiveFailures = 0
    receivedBytes = result.receivedBytes
    report()
    if (result.done) return result.item ?? null
  }
}
