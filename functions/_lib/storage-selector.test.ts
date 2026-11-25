import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { BlobStoreError } from './blob-store.ts'
import { clearAccessTokenCache } from './google-oauth.ts'
import { encryptSecret } from './secret-box.ts'
import type { StorageAccount, StorageRepository } from './storage-repository.ts'
import { selectStorageAccount, StorageFullError } from './storage-selector.ts'

const NOW = () => new Date('2030-01-01T00:00:00.000Z')
const FRESH = '2029-12-31T23:55:00.000Z'
const STALE = '2029-01-01T00:00:00.000Z'

function account(overrides: Partial<StorageAccount> = {}): StorageAccount {
  return {
    id: 1,
    google_email: 'a@example.com',
    refresh_token_ciphertext: 'ciphertext',
    refresh_token_iv: 'iv',
    root_folder_id: 'root',
    connected_by: 'admin',
    status: 'active',
    quota_total: 1000,
    quota_used: 0,
    quota_checked_at: FRESH,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function repository(options: {
  accounts?: StorageAccount[]
  pending?: Map<number, number>
} = {}): StorageRepository {
  const pending = options.pending ?? new Map<number, number>()
  return {
    getAccount: async (id) => options.accounts?.find((item) => item.id === id) ?? null,
    listAccounts: async () => options.accounts ?? [],
    listAccountsWithStats: async () => [],
    countAccounts: async () => 0,
    findAccountByEmail: async () => null,
    createAccount: async () => { throw new Error('not_implemented') },
    updateAccountTokens: async () => null,
    setAccountStatus: async () => null,
    setAccountReauth: async () => undefined,
    setAccountQuota: async () => undefined,
    deleteAccount: async () => undefined,
    countFilesByAccount: async () => 0,
    pendingBytesByAccount: async (id) => pending.get(id) ?? 0,
    findUserFolder: async () => null,
    setUserFolderIfEmpty: async () => false,
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async () => undefined,
    consumeOAuthState: async () => null,
    findAdminUserById: async () => null,
  }
}

const noFetch: typeof fetch = async () => {
  throw new Error('unexpected fetch')
}

beforeEach(() => {
  clearAccessTokenCache()
})

test('selects the active account with the most available space that fits', async () => {
  const accounts = [
    account({ id: 1, quota_total: 1000, quota_used: 500 }),
    account({ id: 2, quota_total: 1000, quota_used: 0 }),
    account({ id: 3, quota_total: 1000, quota_used: 900 }),
  ]
  const result = await selectStorageAccount({}, repository({ accounts }), noFetch, 200, NOW)
  assert.equal(result.id, 2)
})

test('deducts pending upload bytes from each account before choosing', async () => {
  const accounts = [
    account({ id: 1, quota_total: 1000, quota_used: 0 }),
    account({ id: 2, quota_total: 1000, quota_used: 500 }),
  ]
  const pending = new Map([[1, 600]])
  const result = await selectStorageAccount({}, repository({ accounts, pending }), noFetch, 450, NOW)
  assert.equal(result.id, 2)
})

test('skips readonly and reauth accounts and rejects when none are active', async () => {
  const accounts = [
    account({ id: 1, quota_total: 1000, quota_used: 0 }),
    account({ id: 2, status: 'readonly', quota_total: 100000, quota_used: 0 }),
    account({ id: 3, status: 'reauth', quota_total: 100000, quota_used: 0 }),
  ]
  const result = await selectStorageAccount({}, repository({ accounts }), noFetch, 100, NOW)
  assert.equal(result.id, 1)

  const inactive = [account({ id: 2, status: 'readonly' }), account({ id: 3, status: 'reauth' })]
  await assert.rejects(
    selectStorageAccount({}, repository({ accounts: inactive }), noFetch, 100, NOW),
    (error: unknown) => error instanceof BlobStoreError && error.message === 'storage_not_connected',
  )
})

test('reports required and largest available when nothing fits', async () => {
  const accounts = [
    account({ id: 1, quota_total: 1000, quota_used: 900 }),
    account({ id: 2, quota_total: 1000, quota_used: 950 }),
  ]
  await assert.rejects(
    selectStorageAccount({}, repository({ accounts }), noFetch, 500, NOW),
    (error: unknown) => error instanceof StorageFullError && error.required === 500 && error.largestAvailable === 100,
  )
})

test('refreshes at most three stale accounts and keeps old values for the rest', async () => {
  const key = Buffer.from('2'.repeat(32), 'ascii').toString('base64url')
  const encrypted = await encryptSecret('refresh-value', key)
  const accounts = [1, 2, 3, 4, 5].map((id) => account({
    id,
    refresh_token_ciphertext: encrypted.ciphertext,
    refresh_token_iv: encrypted.iv,
    quota_total: 1000,
    quota_used: 0,
    quota_checked_at: STALE,
  }))
  const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', STORAGE_ENCRYPTION_KEY: key }
  let aboutCalls = 0
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    aboutCalls += 1
    return new Response(JSON.stringify({ storageQuota: { limit: '400', usage: '0' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const result = await selectStorageAccount(env, repository({ accounts }), fetchImpl, 1, NOW)
  assert.equal(aboutCalls, 3)
  assert.equal(result.id, 4)
})
