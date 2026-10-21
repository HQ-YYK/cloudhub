export type BlobMetadata = Readonly<Record<string, string>>

export type BlobBody = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>

export interface BlobPutInput {
  objectKey: string
  body: BlobBody
  metadata?: BlobMetadata
  contentType?: string
  overwrite?: boolean
}

export interface BlobObject {
  objectKey: string
  body: ReadableStream<Uint8Array>
  sizeBytes: number
  metadata: BlobMetadata
  contentType: string | null
  etag: string
}

export interface BlobHead {
  objectKey: string
  sizeBytes: number
  metadata: BlobMetadata
  contentType: string | null
  etag: string
}

export type BlobStoreErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_request'
  | 'too_large'
  | 'unavailable'

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode

  constructor(code: BlobStoreErrorCode, message: string = code) {
    super(message)
    this.name = 'BlobStoreError'
    this.code = code
  }
}

export interface BlobStore {
  put(input: BlobPutInput): Promise<BlobHead>
  get(objectKey: string): Promise<BlobObject>
  head(objectKey: string): Promise<BlobHead>
  delete(objectKey: string): Promise<void>
}
