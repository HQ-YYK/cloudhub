import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlobStoreError } from './blob-store.ts'
import { clearAccessTokenCache, getAccessToken } from './google-oauth.ts'
import { encryptSecret } from './secret-box.ts'
import type { StorageRepository, StorageAccount } from './storage-repository.ts'

function repository(account: StorageAccount | null): StorageRepository {
  return {
    getAccount: async () => account,
    upsertAccount: async () => undefined,
    deleteAccount: async () => undefined,
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async () => undefined,
    consumeOAuthState: async () => null,
    findAdminUserById: async () => null,
  }
}

test('getAccessToken caches tokens and invalid_grant maps to reauth required', async () => {
  clearAccessTokenCache()
  const key = Buffer.from('2'.repeat(32), 'ascii').toString('base64url')
  const encrypted = await encryptSecret('refresh-value', key)
  const account: StorageAccount = {
    id: 1,
    google_email: 'test@example.com',
    refresh_token_ciphertext: encrypted.ciphertext,
    refresh_token_iv: encrypted.iv,
    root_folder_id: 'folder',
    connected_by: 'admin',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  const env = {
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    STORAGE_ENCRYPTION_KEY: key,
  }
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify({ access_token: 'access-value', expires_in: 3600 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  assert.equal(await getAccessToken(env, repository(account), fetchImpl), 'access-value')
  assert.equal(await getAccessToken(env, repository(account), fetchImpl), 'access-value')
  assert.equal(calls, 1)

  clearAccessTokenCache()
  const invalid = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
  await assert.rejects(
    getAccessToken(env, repository(account), invalid),
    (error: unknown) => error instanceof BlobStoreError
      && error.code === 'unavailable'
      && error.message === 'storage_reauth_required',
  )
})
