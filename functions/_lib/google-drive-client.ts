import { BlobStoreError } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'
import { clearAccessTokenCache, getAccessToken } from './google-oauth.ts'
import type { StorageRepository } from './storage-repository.ts'

export class GoogleDriveClient {
  private readonly env: AuthEnv
  private readonly repository: StorageRepository
  private readonly fetchImpl: typeof fetch

  constructor(
    env: AuthEnv,
    repository: StorageRepository,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.env = env
    this.repository = repository
    this.fetchImpl = fetchImpl
  }

  async authorizedFetch(input: string, init?: RequestInit): Promise<Response> {
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

  async createFolder(name: string, parentId: string): Promise<string> {
    const response = await this.authorizedFetch(
      'https://www.googleapis.com/drive/v3/files?fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        }),
      },
    )
    if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_folder_create_failed')
    const payload = await response.json() as { id?: string }
    if (!payload.id) throw new BlobStoreError('unavailable', 'google_drive_folder_create_failed')
    return payload.id
  }

  async trash(id: string): Promise<void> {
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
    )
    if (response.status === 404) return
    if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_trash_failed')
  }

  async untrash(id: string): Promise<void> {
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: false }),
      },
    )
    if (response.status === 404) throw new BlobStoreError('not_found', 'drive_object_not_found')
    if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_untrash_failed')
  }

  async deletePermanently(id: string): Promise<void> {
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    if (response.status === 404) throw new BlobStoreError('not_found', 'drive_object_not_found')
    if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_delete_failed')
  }

  async updateFile(
    id: string,
    patch: { name?: string; addParents?: string; removeParents?: string },
  ): Promise<void> {
    const params = new URLSearchParams()
    if (patch.addParents !== undefined) params.set('addParents', patch.addParents)
    if (patch.removeParents !== undefined) params.set('removeParents', patch.removeParents)
    const query = params.toString()
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}${query ? `?${query}` : ''}`
    const hasName = patch.name !== undefined
    const response = await this.authorizedFetch(url, {
      method: 'PATCH',
      headers: hasName ? { 'Content-Type': 'application/json' } : undefined,
      body: hasName ? JSON.stringify({ name: patch.name }) : undefined,
    })
    if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_update_failed')
  }

  async getParents(id: string): Promise<string[]> {
    const response = await this.authorizedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=parents`,
    )
    if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_get_parents_failed')
    const payload = await response.json() as { parents?: string[] }
    return payload.parents ?? []
  }
}
