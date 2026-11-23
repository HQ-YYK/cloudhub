import { BlobStoreError, type BlobHead, type BlobObject, type BlobPutInput, type BlobStore } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'
import { clearAccessTokenCache, getAccessToken } from './google-oauth.ts'
import type { StorageRepository } from './storage-repository.ts'

export class GoogleDriveStore implements BlobStore {
  private readonly env: AuthEnv
  private readonly repository: StorageRepository
  private readonly fetchImpl: typeof fetch

  constructor(env: AuthEnv, repository: StorageRepository, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.env = env
    this.repository = repository
    this.fetchImpl = fetchImpl
  }

  private async authorizedFetch(input: string, init?: RequestInit) {
    let token = await getAccessToken(this.env, this.repository, this.fetchImpl)
    let response = await this.fetchImpl(input, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    })
    if (response.status === 401) {
      clearAccessTokenCache()
      token = await getAccessToken(this.env, this.repository, this.fetchImpl)
      response = await this.fetchImpl(input, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${token}`,
        },
      })
    }
    return response
  }

  private async mapResponseError(response: Response): Promise<never> {
    if (response.status === 404) throw new BlobStoreError('not_found', 'drive_object_not_found')
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new BlobStoreError('unavailable', 'google_drive_unavailable')
    }
    throw new BlobStoreError('unavailable', 'google_drive_unavailable')
  }

  async head(id: string): Promise<BlobHead> {
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,size,mimeType,md5Checksum,trashed`,
    )
    if (response.status === 404) throw new BlobStoreError('not_found', 'drive_object_not_found')
    if (response.status === 401) await this.mapResponseError(response)
    if (!response.ok) await this.mapResponseError(response)
    const payload = await response.json() as {
      id?: string
      size?: string
      mimeType?: string
      md5Checksum?: string
      trashed?: boolean
    }
    if (payload.trashed === true) throw new BlobStoreError('not_found', 'drive_object_not_found')
    const sizeBytes = Number(payload.size)
    if (!payload.id || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new BlobStoreError('unavailable', 'google_drive_invalid_response')
    }
    return {
      objectKey: payload.id,
      sizeBytes,
      metadata: {},
      contentType: payload.mimeType ?? null,
      etag: payload.md5Checksum ?? '',
    }
  }

  async get(id: string): Promise<BlobObject> {
    const head = await this.head(id)
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
    )
    if (!response.ok) await this.mapResponseError(response)
    if (!response.body) throw new BlobStoreError('unavailable', 'google_drive_missing_body')
    return {
      objectKey: id,
      body: response.body,
      sizeBytes: head.sizeBytes,
      metadata: {},
      contentType: head.contentType,
      etag: head.etag,
    }
  }

  async delete(id: string): Promise<void> {
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
    )
    if (response.status === 404) return
    if (!response.ok) await this.mapResponseError(response)
  }

  async put(input: BlobPutInput): Promise<BlobHead> {
    void input
    throw new BlobStoreError('invalid_request', 'use_resumable_upload')
  }
}
