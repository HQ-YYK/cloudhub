import {
  BlobStoreError,
  type BlobBody,
  type BlobHead,
  type BlobMetadata,
  type BlobObject,
  type BlobPutInput,
  type BlobStore,
} from './blob-store.ts'
import type { AzureAccessTokenProvider } from './azure-blob-auth.ts'

export const MAX_AZURE_BLOB_SIZE_BYTES = 10 * 1024 * 1024
export const DEFAULT_AZURE_STORAGE_API_VERSION = '2023-11-03'

export interface AzureBlobStoreOptions {
  accountName: string
  containerName: string
  tokenProvider: AzureAccessTokenProvider
  endpoint?: string
  apiVersion?: string
  maxObjectSizeBytes?: number
  fetchImpl?: typeof fetch
}

function invalidRequest(message: string) {
  return new BlobStoreError('invalid_request', message)
}

function validateObjectKey(objectKey: string) {
  if (
    objectKey.length === 0
    || objectKey.length > 1024
    || objectKey.includes('\u0000')
    || objectKey.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw invalidRequest('invalid_blob_object_key')
  }
}

function validateMetadata(metadata: BlobMetadata | undefined) {
  const entries = Object.entries(metadata ?? {})
  if (entries.length > 32) throw invalidRequest('too_many_blob_metadata_entries')
  for (const [key, value] of entries) {
    if (
      key.length === 0
      || key.length > 128
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      || value.length > 8192
      || [...value].some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code <= 0x1f || code === 0x7f
      })
    ) {
      throw invalidRequest('invalid_blob_metadata')
    }
  }
}

function bodyBytes(body: BlobBody, maxObjectSizeBytes: number) {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxObjectSizeBytes) {
      throw new BlobStoreError('too_large', 'blob_object_too_large')
    }
    return body.slice()
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxObjectSizeBytes) {
      throw new BlobStoreError('too_large', 'blob_object_too_large')
    }
    return new Uint8Array(body.slice(0))
  }
  throw invalidRequest('stream_body_requires_known_length')
}

function parseSize(headers: Headers) {
  const value = headers.get('Content-Length')
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw invalidRequest('invalid_blob_content_length')
  }
  const size = Number(value)
  if (!Number.isSafeInteger(size)) throw invalidRequest('invalid_blob_content_length')
  return size
}

function parseEtag(headers: Headers) {
  const etag = headers.get('ETag')
  if (etag === null || etag.length === 0) throw invalidRequest('missing_blob_etag')
  return etag
}

function parseMetadata(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    if (key.startsWith('x-ms-meta-')) {
      metadata[key.slice('x-ms-meta-'.length)] = value
    }
  }
  return metadata
}

function mapResponseError(response: Response): BlobStoreError {
  if (response.status === 404) return new BlobStoreError('not_found', 'blob_not_found')
  if (response.status === 409 || response.status === 412) {
    return new BlobStoreError('conflict', 'blob_conflict')
  }
  if (response.status === 400) return invalidRequest('azure_invalid_request')
  if (response.status === 413) return new BlobStoreError('too_large', 'blob_object_too_large')
  if (response.status === 401 || response.status === 403 || response.status >= 500) {
    return new BlobStoreError('unavailable', 'azure_storage_unavailable')
  }
  return new BlobStoreError('unavailable', 'azure_unexpected_response')
}

function blobUrl(endpoint: string, containerName: string, objectKey: string) {
  validateObjectKey(objectKey)
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw invalidRequest('invalid_blob_endpoint')
  }
  if (base.protocol !== 'https:' || base.search || base.hash) {
    throw invalidRequest('invalid_blob_endpoint')
  }
  const basePath = base.pathname.replace(/\/+$/u, '')
  base.pathname = [
    basePath,
    encodeURIComponent(containerName),
    ...objectKey.split('/').map((segment) => encodeURIComponent(segment)),
  ].join('/')
  return base
}

function headFromResponse(objectKey: string, response: Response): BlobHead {
  return {
    objectKey,
    sizeBytes: parseSize(response.headers),
    metadata: parseMetadata(response.headers),
    contentType: response.headers.get('Content-Type'),
    etag: parseEtag(response.headers),
  }
}

export class AzureBlobStore implements BlobStore {
  private readonly containerName: string
  private readonly tokenProvider: AzureAccessTokenProvider
  private readonly endpoint: string
  private readonly apiVersion: string
  private readonly maxObjectSizeBytes: number
  private readonly fetchImpl: typeof fetch

  constructor(options: AzureBlobStoreOptions) {
    if (options.accountName.length === 0 || options.containerName.length === 0) {
      throw invalidRequest('azure_storage_configuration_invalid')
    }
    if (
      options.maxObjectSizeBytes !== undefined
      && (!Number.isSafeInteger(options.maxObjectSizeBytes) || options.maxObjectSizeBytes < 0)
    ) {
      throw invalidRequest('invalid_blob_size_limit')
    }
    this.containerName = options.containerName
    this.tokenProvider = options.tokenProvider
    this.endpoint = options.endpoint
      ?? `https://${options.accountName}.blob.core.windows.net`
    this.apiVersion = options.apiVersion ?? DEFAULT_AZURE_STORAGE_API_VERSION
    this.maxObjectSizeBytes = options.maxObjectSizeBytes ?? MAX_AZURE_BLOB_SIZE_BYTES
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request(
    method: string,
    objectKey: string,
    options: {
      body?: Uint8Array
      contentType?: string
      metadata?: BlobMetadata
      overwrite?: boolean
    } = {},
  ) {
    const url = blobUrl(this.endpoint, this.containerName, objectKey)
    const token = await this.tokenProvider.getAccessToken()
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      'x-ms-version': this.apiVersion,
    })
    if (options.body) headers.set('Content-Length', String(options.body.byteLength))
    if (options.contentType !== undefined) headers.set('Content-Type', options.contentType)
    if (options.overwrite !== undefined && !options.overwrite) {
      headers.set('If-None-Match', '*')
    }
    for (const [key, value] of Object.entries(options.metadata ?? {})) {
      headers.set(`x-ms-meta-${key}`, value)
    }
    if (method === 'PUT') headers.set('x-ms-blob-type', 'BlockBlob')

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body,
        redirect: 'error',
      })
    } catch {
      throw new BlobStoreError('unavailable', 'azure_storage_unavailable')
    }
    return response
  }

  async put(input: BlobPutInput) {
    validateMetadata(input.metadata)
    if (
      input.contentType !== undefined
      && (
        input.contentType.length === 0
        || [...input.contentType].some((character) => {
          const code = character.codePointAt(0) ?? 0
          return code <= 0x1f || code === 0x7f
        })
      )
    ) {
      throw invalidRequest('invalid_blob_content_type')
    }
    const bytes = bodyBytes(input.body, this.maxObjectSizeBytes)
    const response = await this.request('PUT', input.objectKey, {
      body: bytes,
      contentType: input.contentType,
      metadata: input.metadata,
      overwrite: input.overwrite ?? false,
    })
    if (response.status !== 201) throw mapResponseError(response)
    return {
      objectKey: input.objectKey,
      sizeBytes: bytes.byteLength,
      metadata: { ...input.metadata },
      contentType: input.contentType ?? 'application/octet-stream',
      etag: parseEtag(response.headers),
    }
  }

  async get(objectKey: string): Promise<BlobObject> {
    const response = await this.request('GET', objectKey)
    if (response.status !== 200) throw mapResponseError(response)
    const head = headFromResponse(objectKey, response)
    if (!response.body) throw new BlobStoreError('unavailable', 'azure_missing_blob_body')
    return { ...head, body: response.body }
  }

  async head(objectKey: string) {
    const response = await this.request('HEAD', objectKey)
    if (response.status !== 200) throw mapResponseError(response)
    return headFromResponse(objectKey, response)
  }

  async delete(objectKey: string) {
    const response = await this.request('DELETE', objectKey)
    if (response.status !== 202) throw mapResponseError(response)
  }
}
