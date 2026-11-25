import { BlobStoreError } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'
import { decryptSecret } from './secret-box.ts'
import type { StorageRepository } from './storage-repository.ts'

const accessTokenCache = new Map<number, { token: string; expiresAt: number }>()

export function clearAccessTokenCache(accountId?: number) {
  if (accountId === undefined) accessTokenCache.clear()
  else accessTokenCache.delete(accountId)
}

export async function getAccessToken(
  env: AuthEnv,
  repository: StorageRepository,
  accountId: number,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
) {
  const cached = accessTokenCache.get(accountId)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token
  }

  const account = await repository.getAccount(accountId)
  if (!account) throw new BlobStoreError('unavailable', 'storage_not_connected')
  if (
    !env.GOOGLE_CLIENT_ID
    || !env.GOOGLE_CLIENT_SECRET
    || !env.STORAGE_ENCRYPTION_KEY
  ) {
    throw new BlobStoreError('unavailable', 'storage_not_configured')
  }

  const refreshToken = await decryptSecret(
    account.refresh_token_ciphertext,
    account.refresh_token_iv,
    env.STORAGE_ENCRYPTION_KEY,
  )
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  let payload: { access_token?: string, expires_in?: number, error?: string }
  try {
    payload = await response.json() as typeof payload
  } catch {
    throw new BlobStoreError('unavailable', 'google_token_response_invalid')
  }
  if (!response.ok) {
    if (payload.error === 'invalid_grant') {
      await repository.setAccountReauth(accountId, new Date().toISOString())
      throw new BlobStoreError('unavailable', 'storage_reauth_required')
    }
    throw new BlobStoreError('unavailable', 'google_token_unavailable')
  }
  if (!payload.access_token) {
    throw new BlobStoreError('unavailable', 'google_token_response_invalid')
  }

  const lifetimeSeconds = Number(payload.expires_in)
  const lifetimeMs = Number.isSafeInteger(lifetimeSeconds) && lifetimeSeconds > 0
    ? lifetimeSeconds * 1000
    : 3600 * 1000
  accessTokenCache.set(accountId, {
    token: payload.access_token,
    expiresAt: Date.now() + lifetimeMs,
  })
  return payload.access_token
}
