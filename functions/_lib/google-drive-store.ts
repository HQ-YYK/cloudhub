import { BlobStoreError, type BlobHead, type BlobObject, type BlobPutInput, type BlobStore } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'
import { GoogleDriveClient } from './google-drive-client.ts'
import type { StorageRepository } from './storage-repository.ts'

export class GoogleDriveStore implements BlobStore {
  private readonly client: GoogleDriveClient
  private readonly accountId: number

  constructor(env: AuthEnv, repository: StorageRepository, accountId = 1, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.client = new GoogleDriveClient(env, repository, fetchImpl)
    this.accountId = accountId
  }

  private async mapResponseError(response: Response): Promise<never> {
    if (response.status === 404) throw new BlobStoreError('not_found', 'drive_object_not_found')
    throw new BlobStoreError('unavailable', 'google_drive_unavailable')
  }

  async head(id: string): Promise<BlobHead> {
    const response = await this.client.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,size,mimeType,md5Checksum,trashed`,
      undefined,
      this.accountId,
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

  async get(id: string, range?: { start: number; end: number }): Promise<BlobObject> {
    const head = await this.head(id)
    const response = range
      ? await this.client.authorizedFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
        { headers: { Range: `bytes=${range.start}-${range.end}` } },
        this.accountId,
      )
      : await this.client.authorizedFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
        undefined,
        this.accountId,
      )
    if (range && response.status !== 206) await this.mapResponseError(response)
    if (!response.ok) await this.mapResponseError(response)
    if (!response.body) throw new BlobStoreError('unavailable', 'google_drive_missing_body')
    return {
      objectKey: id,
      body: response.body,
      sizeBytes: range ? range.end - range.start + 1 : head.sizeBytes,
      metadata: {},
      contentType: head.contentType,
      etag: head.etag,
      ...(range ? { range: { start: range.start, end: range.end, total: head.sizeBytes } } : {}),
    }
  }

  async delete(id: string): Promise<void> {
    const response = await this.client.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
      this.accountId,
    )
    if (response.status === 404) return
    if (!response.ok) await this.mapResponseError(response)
  }

  async put(input: BlobPutInput): Promise<BlobHead> {
    void input
    throw new BlobStoreError('invalid_request', 'use_resumable_upload')
  }
}
