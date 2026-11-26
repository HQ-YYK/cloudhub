import { chunkCount, decryptChunk, plainSizeFromCipher } from '../crypto/index.ts'
import { chunkCipherRange } from './chunks.ts'

export const SEGMENT_SIZE = 4 * 1024 * 1024
const MAX_CONCURRENT_SEGMENTS = 4
const SEGMENT_IDLE_TIMEOUT_MS = 30_000
const SEGMENT_RETRY_DELAYS = [1000, 3000, 5000, 10000]
const SEGMENT_ATTEMPTS = 5
const MAX_IN_MEMORY_CONFIRM = 500 * 1024 * 1024
const MAX_IN_MEMORY_STRICT = 4 * 1024 * 1024 * 1024

export class DownloadError extends Error {
  readonly code: 'decrypt_failed' | 'cancelled' | 'too_large' | 'incomplete'

  constructor(code: DownloadError['code']) {
    super(code)
    this.name = 'DownloadError'
    this.code = code
  }
}

class SegmentTimeoutError extends Error {
  constructor() {
    super('segment_timeout')
    this.name = 'SegmentTimeoutError'
  }
}

class SegmentIncompleteError extends Error {
  constructor() {
    super('segment_incomplete')
    this.name = 'SegmentIncompleteError'
  }
}

export type RangeStreamFetcher = (
  start: number,
  end: number,
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array<ArrayBuffer>>>

export type DownloadProgressInfo = {
  receivedBytes: number
  totalBytes: number
  speedBytesPerSecond: number | null
  etaSeconds: number | null
}

export function canStreamSave(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatRemaining(seconds: number): string {
  const total = Math.max(1, Math.round(seconds))
  if (total < 60) return `${total} 秒`
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const secs = total % 60
    return `${minutes} 分 ${secs} 秒`
  }
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${hours} 小时 ${minutes} 分`
}

export function formatDownloadStatus(
  receivedBytes: number,
  totalBytes: number,
  speedBytesPerSecond: number | null,
  etaSeconds: number | null,
): string {
  let label = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
  if (speedBytesPerSecond !== null) label += ` · ${formatSpeed(speedBytesPerSecond)}`
  if (etaSeconds !== null) label += ` · 剩余约 ${formatRemaining(etaSeconds)}`
  return label
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Some browsers hand the user a truncated or empty file when the object URL is
  // revoked in the same task that triggered the click; keep it alive for a minute.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function verifyPlainTotal(writtenBytes: number, plainSize: number): void {
  if (writtenBytes !== plainSize) throw new DownloadError('incomplete')
}

// `end` is exclusive. Splits a cipher chunk range into fixed-size segments.
export function cipherSegments(start: number, end: number, segmentSize = SEGMENT_SIZE): { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = []
  for (let offset = start; offset < end; offset += segmentSize) {
    segments.push({ start: offset, end: Math.min(offset + segmentSize, end) })
  }
  return segments
}

type SpeedSample = { time: number; received: number }

class SpeedMeter {
  private readonly windowMs: number
  private readonly samples: SpeedSample[] = []

  constructor(windowMs = 5000) {
    this.windowMs = windowMs
  }

  add(received: number): void {
    const now = Date.now()
    this.samples.push({ time: now, received })
    while (this.samples.length > 0 && now - this.samples[0].time > this.windowMs) this.samples.shift()
  }

  speed(): number | null {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedMs = last.time - first.time
    if (elapsedMs < 1000) return null
    const bytes = last.received - first.received
    if (bytes <= 0) return null
    return (bytes / elapsedMs) * 1000
  }

  eta(totalBytes: number, receivedBytes: number): number | null {
    const speed = this.speed()
    if (speed === null || speed <= 0) return null
    return (totalBytes - receivedBytes) / speed
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function concatBytes(parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

async function readSegmentOnce(
  fetchRange: RangeStreamFetcher,
  start: number,
  end: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  idleTimeoutMs: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = await fetchRange(start, end, signal)
  const reader = stream.getReader()
  const parts: Uint8Array<ArrayBuffer>[] = []
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancelReader = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancelReader, { once: true })

  const armTimer = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      cancelReader()
    }, idleTimeoutMs)
  }

  try {
    armTimer()
    while (true) {
      if (signal.aborted) throw new DownloadError('cancelled')
      const { done, value } = await reader.read()
      if (signal.aborted) throw new DownloadError('cancelled')
      if (timedOut) throw new SegmentTimeoutError()
      if (done) break
      if (value) {
        parts.push(value)
        onBytes(value.byteLength)
      }
      armTimer()
    }
    const bytes = concatBytes(parts)
    if (bytes.byteLength !== end - start) throw new SegmentIncompleteError()
    return bytes
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', cancelReader)
  }
}

async function fetchSegmentWithRetry(
  fetchRange: RangeStreamFetcher,
  start: number,
  end: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  attempts: number,
  idleTimeoutMs: number,
  retryDelays: number[],
): Promise<Uint8Array<ArrayBuffer>> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw new DownloadError('cancelled')
    let counted = 0
    const countBytes = (bytes: number) => {
      counted += bytes
      onBytes(bytes)
    }
    try {
      return await readSegmentOnce(fetchRange, start, end, signal, countBytes, idleTimeoutMs)
    } catch (error) {
      // Take back the bytes of the failed attempt so progress never runs ahead.
      if (counted > 0) onBytes(-counted)
      if (signal.aborted) throw new DownloadError('cancelled')
      lastError = error
      if (attempt < attempts - 1) await sleep(retryDelays[attempt] ?? 10000, signal)
    }
  }
  throw lastError
}

type SegmentOptions = {
  segmentSize: number
  maxConcurrent: number
  idleTimeoutMs: number
  retryDelays: number[]
  attempts: number
}

async function fetchChunkSegments(
  fetchRange: RangeStreamFetcher,
  start: number,
  end: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  options: SegmentOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const segments = cipherSegments(start, end, options.segmentSize)
  const results = new Array<Uint8Array<ArrayBuffer>>(segments.length)
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) throw new DownloadError('cancelled')
      const index = nextIndex
      nextIndex += 1
      if (index >= segments.length) return
      const segment = segments[index]
      results[index] = await fetchSegmentWithRetry(
        fetchRange,
        segment.start,
        segment.end,
        signal,
        onBytes,
        options.attempts,
        options.idleTimeoutMs,
        options.retryDelays,
      )
    }
  }

  const workerCount = Math.min(options.maxConcurrent, segments.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return concatBytes(results)
}

async function fetchAndDecryptChunk(
  fetchRange: RangeStreamFetcher,
  start: number,
  end: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  attempts: number,
  fk: Uint8Array<ArrayBuffer>,
  fileId: string,
  index: number,
  isLast: boolean,
  segmentOptions: SegmentOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw new DownloadError('cancelled')
    let cipherBytes: Uint8Array<ArrayBuffer>
    let counted = 0
    const countBytes = (bytes: number) => {
      counted += bytes
      onBytes(bytes)
    }
    try {
      cipherBytes = await fetchChunkSegments(fetchRange, start, end, signal, countBytes, segmentOptions)
    } catch (error) {
      if (signal.aborted) throw new DownloadError('cancelled')
      throw error
    }
    try {
      return await decryptChunk(fk, fileId, index, isLast, cipherBytes)
    } catch {
      onBytes(-counted)
      // Refetch the whole chunk before reporting corruption; transient bit flips
      // during transfer are retried just like network stalls.
    }
  }
  throw new DownloadError('decrypt_failed')
}

export async function streamDecryptedChunks(options: {
  fk: Uint8Array<ArrayBuffer>
  fileId: string
  cipherSize: number
  fetchRange: RangeStreamFetcher
  onProgress: (progress: DownloadProgressInfo) => void
  signal: AbortSignal
  attempts?: number
  segmentSize?: number
  maxConcurrentSegments?: number
  segmentIdleTimeoutMs?: number
  segmentRetryDelays?: number[]
  segmentAttempts?: number
  sink: (plain: Uint8Array<ArrayBuffer>, index: number) => Promise<void> | void
}): Promise<void> {
  const {
    fk,
    fileId,
    cipherSize,
    fetchRange,
    onProgress,
    signal,
    attempts = 5,
    segmentSize = SEGMENT_SIZE,
    maxConcurrentSegments = MAX_CONCURRENT_SEGMENTS,
    segmentIdleTimeoutMs = SEGMENT_IDLE_TIMEOUT_MS,
    segmentRetryDelays = SEGMENT_RETRY_DELAYS,
    segmentAttempts = SEGMENT_ATTEMPTS,
    sink,
  } = options

  const plainSize = plainSizeFromCipher(cipherSize)
  const speedMeter = new SpeedMeter()
  let cipherReceived = 0

  const onBytes = (bytes: number) => {
    cipherReceived += bytes
    speedMeter.add(cipherReceived)
    const receivedBytes = Math.max(0, Math.min(plainSize, cipherReceived))
    onProgress({
      receivedBytes,
      totalBytes: plainSize,
      speedBytesPerSecond: speedMeter.speed(),
      etaSeconds: speedMeter.eta(plainSize, receivedBytes),
    })
  }

  const segmentOptions: SegmentOptions = {
    segmentSize,
    maxConcurrent: maxConcurrentSegments,
    idleTimeoutMs: segmentIdleTimeoutMs,
    retryDelays: segmentRetryDelays,
    attempts: segmentAttempts,
  }

  const startChunk = (index: number): Promise<Uint8Array<ArrayBuffer>> => {
    const { start, end, isLast } = chunkCipherRange(index, cipherSize)
    return fetchAndDecryptChunk(fetchRange, start, end, signal, onBytes, attempts, fk, fileId, index, isLast, segmentOptions)
  }

  const chunks = chunkCount(plainSize)
  let pending: Promise<Uint8Array<ArrayBuffer>> | null = startChunk(0)
  for (let index = 0; index < chunks; index += 1) {
    if (signal.aborted) throw new DownloadError('cancelled')
    const plain = await pending!
    // Prefetch the next chunk while the current one is being written, keeping
    // at most two chunks in memory at a time.
    pending = index + 1 < chunks ? startChunk(index + 1) : null
    await sink(plain, index)
  }
}

export async function downloadEncryptedFile(options: {
  fk: Uint8Array<ArrayBuffer>
  fileId: string
  cipherSize: number
  fileName: string
  fetchRange: RangeStreamFetcher
  onProgress: (progress: DownloadProgressInfo) => void
  signal: AbortSignal
  attempts?: number
}): Promise<void> {
  const { fk, fileId, cipherSize, fileName, fetchRange, onProgress, signal, attempts } = options
  const plainSize = plainSizeFromCipher(cipherSize)
  const stream = canStreamSave()

  if (!stream) {
    if (plainSize >= MAX_IN_MEMORY_STRICT) throw new DownloadError('too_large')
    if (plainSize >= MAX_IN_MEMORY_CONFIRM) {
      const ok = window.confirm(
        `你的浏览器不支持边下载边保存，这个文件（${formatBytes(plainSize)}）需要先完整放进内存，可能导致页面卡顿或崩溃。建议用 Chrome 或 Edge 下载大文件。继续吗？`,
      )
      if (!ok) throw new DownloadError('cancelled')
    }
  }

  let writable: FileSystemWritableFileStream | null = null
  const parts: Uint8Array<ArrayBuffer>[] = []

  if (stream) {
    let handle: FileSystemFileHandle
    try {
      handle = await window.showSaveFilePicker!({ suggestedName: fileName })
    } catch {
      throw new DownloadError('cancelled')
    }
    writable = await handle.createWritable()
  }

  let writtenPlainBytes = 0
  try {
    await streamDecryptedChunks({
      fk,
      fileId,
      cipherSize,
      fetchRange,
      onProgress,
      signal,
      attempts,
      sink: async (plain) => {
        if (writable) await writable.write(plain)
        else parts.push(plain)
        writtenPlainBytes += plain.length
      },
    })
    // Never hand the user a truncated file: the decrypted total must match the
    // size the ciphertext implies before we close or save anything.
    verifyPlainTotal(writtenPlainBytes, plainSize)
    if (writable) await writable.close()
    else saveBlob(new Blob(parts), fileName)
  } catch (error) {
    if (writable) {
      try {
        await writable.abort()
      } catch {
        // Ignore abort failures; the original error matters more.
      }
    }
    throw error
  }
}
