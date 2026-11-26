import { chunkCount, decryptChunk, plainSizeFromCipher } from '../crypto/index.ts'
import { chunkCipherRange } from './chunks.ts'

const MAX_IN_MEMORY_CONFIRM = 500 * 1024 * 1024
const MAX_IN_MEMORY_STRICT = 4 * 1024 * 1024 * 1024

export class DownloadError extends Error {
  readonly code: 'decrypt_failed' | 'cancelled' | 'too_large'

  constructor(code: DownloadError['code']) {
    super(code)
    this.name = 'DownloadError'
    this.code = code
  }
}

export function canStreamSave(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

export type RangeFetcher = (start: number, end: number, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

async function fetchAndDecryptChunk(
  fetchRange: RangeFetcher,
  start: number,
  end: number,
  signal: AbortSignal,
  attempts: number,
  fk: Uint8Array<ArrayBuffer>,
  fileId: string,
  index: number,
  isLast: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const cipherBytes = await fetchRange(start, end, signal)
      try {
        return await decryptChunk(fk, fileId, index, isLast, cipherBytes)
      } catch {
        throw new DownloadError('decrypt_failed')
      }
    } catch (error) {
      lastError = error
      if (signal.aborted) throw error
    }
  }
  throw lastError
}

export async function downloadEncryptedFile(options: {
  fk: Uint8Array<ArrayBuffer>
  fileId: string
  cipherSize: number
  fileName: string
  fetchRange: RangeFetcher
  onProgress: (downloaded: number, total: number) => void
  signal: AbortSignal
  attempts?: number
}): Promise<void> {
  const { fk, fileId, cipherSize, fileName, fetchRange, onProgress, signal, attempts = 3 } = options
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

  let accumulated = 0
  try {
    const chunks = chunkCount(plainSize)
    for (let index = 0; index < chunks; index += 1) {
      if (signal.aborted) throw new DownloadError('cancelled')
      const { start, end, isLast } = chunkCipherRange(index, cipherSize)
      const plain = await fetchAndDecryptChunk(fetchRange, start, end, signal, attempts, fk, fileId, index, isLast)
      if (writable) await writable.write(plain)
      else parts.push(plain)
      accumulated += plain.length
      onProgress(accumulated, plainSize)
    }
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
