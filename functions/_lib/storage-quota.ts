import type { AuthEnv } from './cloudflare-env.ts'
import { getAccessToken } from './google-oauth.ts'
import type { StorageRepository } from './storage-repository.ts'

export interface StorageQuota {
  quotaTotal: number | null
  quotaUsed: number | null
}

function parseBytes(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

export async function refreshStorageQuota(
  env: AuthEnv,
  repository: StorageRepository,
  accountId: number,
  fetchImpl: typeof fetch,
): Promise<StorageQuota> {
  const token = await getAccessToken(env, repository, accountId, fetchImpl)
  const response = await fetchImpl('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error('storage_quota_refresh_failed')
  const payload = await response.json() as { storageQuota?: { limit?: string; usage?: string } }
  return {
    quotaTotal: parseBytes(payload.storageQuota?.limit),
    quotaUsed: parseBytes(payload.storageQuota?.usage),
  }
}
