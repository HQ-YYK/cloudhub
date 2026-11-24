import {
  BlobStoreError,
  type BlobBody,
  type BlobHead,
  type BlobMetadata,
  type BlobObject,
  type BlobPutInput,
  type BlobStore,
} from './blob-store.ts'

export const MAX_BLOB_OBJECT_KEY_LENGTH = 1024
export const MAX_BLOB_METADATA_ENTRIES = 32
export const MAX_BLOB_METADATA_KEY_LENGTH = 128
export const MAX_BLOB_METADATA_VALUE_LENGTH = 8192

interface StoredBlob {
  bytes: Uint8Array
  metadata: Record<string, string>
  contentType: string | null
  etag: string
}

export interface MockBlobStoreOptions {
  maxObjectSizeBytes?: number
}

function cloneMetadata(metadata: BlobMetadata | undefined) {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (
      key.length === 0
      || key.length > MAX_BLOB_METADATA_KEY_LENGTH
      || value.length > MAX_BLOB_METADATA_VALUE_LENGTH
    ) {
      throw new BlobStoreError('invalid_request', 'invalid_blob_metadata')
    }
    result[key] = value
  }
  if (Object.keys(result).length > MAX_BLOB_METADATA_ENTRIES) {
    throw new BlobStoreError('invalid_request', 'too_many_blob_metadata_entries')
  }
  return result
}

function validateObjectKey(objectKey: string) {
  if (
    objectKey.length === 0
    || objectKey.length > MAX_BLOB_OBJECT_KEY_LENGTH
    || objectKey.includes('\u0000')
  ) {
    throw new BlobStoreError('invalid_request', 'invalid_blob_object_key')
  }
}

function streamFromBytes(bytes: Uint8Array) {
  const copy = bytes.slice()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy)
      controller.close()
    },
  })
}

async function readBody(body: BlobBody, maxObjectSizeBytes: number | undefined) {
  if (body instanceof Uint8Array) return body.slice()
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (maxObjectSizeBytes !== undefined && size > maxObjectSizeBytes) {
        throw new BlobStoreError('too_large', 'blob_object_too_large')
      }
      chunks.push(result.value.slice())
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function toHead(objectKey: string, blob: StoredBlob): BlobHead {
  return {
    objectKey,
    sizeBytes: blob.bytes.byteLength,
    metadata: { ...blob.metadata },
    contentType: blob.contentType,
    etag: blob.etag,
  }
}

export class MockBlobStore implements BlobStore {
  private readonly blobs = new Map<string, StoredBlob>()
  private readonly maxObjectSizeBytes: number | undefined
  private etagSequence = 0

  constructor(options: MockBlobStoreOptions = {}) {
    if (
      options.maxObjectSizeBytes !== undefined
      && (!Number.isSafeInteger(options.maxObjectSizeBytes) || options.maxObjectSizeBytes < 0)
    ) {
      throw new BlobStoreError('invalid_request', 'invalid_blob_size_limit')
    }
    this.maxObjectSizeBytes = options.maxObjectSizeBytes
  }

  async put(input: BlobPutInput) {
    validateObjectKey(input.objectKey)
    const metadata = cloneMetadata(input.metadata)
    if (input.contentType !== undefined && input.contentType.length === 0) {
      throw new BlobStoreError('invalid_request', 'invalid_blob_content_type')
    }
    if (this.blobs.has(input.objectKey) && input.overwrite !== true) {
      throw new BlobStoreError('conflict', 'blob_already_exists')
    }

    const bytes = await readBody(input.body, this.maxObjectSizeBytes)
    if (this.maxObjectSizeBytes !== undefined && bytes.byteLength > this.maxObjectSizeBytes) {
      throw new BlobStoreError('too_large', 'blob_object_too_large')
    }
    const blob: StoredBlob = {
      bytes,
      metadata,
      contentType: input.contentType ?? null,
      etag: `"mock-${++this.etagSequence}"`,
    }
    this.blobs.set(input.objectKey, blob)
    return toHead(input.objectKey, blob)
  }

  async get(objectKey: string, range?: { start: number; end: number }) {
    const blob = this.blobs.get(objectKey)
    if (!blob) throw new BlobStoreError('not_found', 'blob_not_found')
    if (range) {
      const bytes = blob.bytes.slice(range.start, range.end + 1)
      return {
        objectKey,
        body: streamFromBytes(bytes),
        sizeBytes: bytes.byteLength,
        metadata: { ...blob.metadata },
        contentType: blob.contentType,
        etag: blob.etag,
        range: { start: range.start, end: range.end, total: blob.bytes.byteLength },
      } satisfies BlobObject
    }
    return {
      ...toHead(objectKey, blob),
      body: streamFromBytes(blob.bytes),
    } satisfies BlobObject
  }

  async head(objectKey: string) {
    const blob = this.blobs.get(objectKey)
    if (!blob) throw new BlobStoreError('not_found', 'blob_not_found')
    return toHead(objectKey, blob)
  }

  async delete(objectKey: string) {
    if (!this.blobs.delete(objectKey)) {
      throw new BlobStoreError('not_found', 'blob_not_found')
    }
  }
}
