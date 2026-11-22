import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlobStoreError } from './blob-store.ts'
import { GoogleDriveStore } from './google-drive-store.ts'
import { clearAccessTokenCache } from './google-oauth.ts'
import type { StorageRepository } from './storage-repository.ts'

const emptyRepository: StorageRepository = {
  getAccount: async () => null,
  upsertAccount: async () => undefined,
  deleteAccount: async () => undefined,
  deleteExpiredOAuthStates: async () => undefined,
  createOAuthState: async () => undefined,
  consumeOAuthState: async () => null,
  findAdminUserById: async () => null,
}

test('GoogleDriveStore maps trashed and missing objects to not_found', async () => {
  clearAccessTokenCache()
  const env = {
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    STORAGE_ENCRYPTION_KEY: Buffer.from('3'.repeat(32), 'ascii').toString('base64url'),
  }
  const account = await import('./secret-box.ts').then(({ encryptSecret }) =>
    encryptSecret('refresh', env.STORAGE_ENCRYPTION_KEY),
  )
  const repository: StorageRepository = {
    ...emptyRepository,
    getAccount: async () => ({
      id: 1,
      google_email: 'test@example.com',
      refresh_token_ciphertext: account.ciphertext,
      refresh_token_iv: account.iv,
      root_folder_id: 'root',
      connected_by: 'admin',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
  }
  const store = new GoogleDriveStore(env, repository, async (input, init) => {
    if (String(input).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (String(input).includes('missing')) return new Response(null, { status: 404 })
    if (String(input).includes('trashed')) {
      return new Response(JSON.stringify({ id: 'trashed', size: '1', trashed: true }), { status: 200 })
    }
    if (init?.method === 'PATCH') return new Response('{}', { status: 200 })
    return new Response(JSON.stringify({ id: 'file', size: '1', mimeType: 'text/plain', md5Checksum: 'etag', trashed: false }), { status: 200 })
  })
 

  await assert.rejects(store.head('missing'), (error: unknown) => error instanceof BlobStoreError && error.code === 'not_found')
  await assert.rejects(store.head('trashed'), (error: unknown) => error instanceof BlobStoreError && error.code === 'not_found')
})

test('GoogleDriveStore get streams, delete trashes, and put rejects', async () => {
  clearAccessTokenCache()
  const key = Buffer.from('4'.repeat(32), 'ascii').toString('base64url')
  const encrypted = await import('./secret-box.ts').then(({ encryptSecret }) => encryptSecret('refresh', key))
  const repository: StorageRepository = {
    ...emptyRepository,
    getAccount: async () => ({
      id: 1,
      google_email: 'test@example.com',
      refresh_token_ciphertext: encrypted.ciphertext,
      refresh_token_iv: encrypted.iv,
      root_folder_id: 'root',
      connected_by: 'admin',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
  }
  let deleteBody = ''
  const store = new GoogleDriveStore(
    { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', STORAGE_ENCRYPTION_KEY: key },
    repository,
    async (input, init) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (String(input).includes('alt=media')) {
        return new Response('hello', { status: 200 })
      }
      if (init?.method === 'PATCH') {
        deleteBody = String(init.body)
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'file', size: '5', mimeType: 'text/plain', md5Checksum: 'etag', trashed: false }), { status: 200 })
    },
  )
  const object = await store.get('file')
  assert.equal(await new Response(object.body).text(), 'hello')
  await store.delete('file')
  assert.deepEqual(JSON.parse(deleteBody), { trashed: true })
  await assert.rejects(
    store.put({ objectKey: 'file', body: new Uint8Array() }),
    (error: unknown) => error instanceof BlobStoreError && error.message === 'use_resumable_upload',
  )
})

test('GoogleDriveStore refreshes token and retries once after 401', async () => {
  clearAccessTokenCache()
  const key = Buffer.from('6'.repeat(32), 'ascii').toString('base64url')
  const encrypted = await import('./secret-box.ts').then(({ encryptSecret }) => encryptSecret('refresh', key))
  const repository: StorageRepository = {
    ...emptyRepository,
    getAccount: async () => ({
      id: 1,
      google_email: 'test@example.com',
      refresh_token_ciphertext: encrypted.ciphertext,
      refresh_token_iv: encrypted.iv,
      root_folder_id: 'root',
      connected_by: 'admin',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
  }
  let tokenCalls = 0
  let driveCalls = 0
  const store = new GoogleDriveStore(
    { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', STORAGE_ENCRYPTION_KEY: key },
    repository,
    async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        tokenCalls += 1
        return new Response(JSON.stringify({
          access_token: tokenCalls === 1 ? 'old-access' : 'new-access',
          expires_in: 3600,
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      driveCalls += 1
      if (driveCalls === 1) return new Response(null, { status: 401 })
      return new Response(JSON.stringify({
        id: 'file',
        size: '5',
        mimeType: 'text/plain',
        md5Checksum: 'etag',
        trashed: false,
      }), { status: 200 })
    },
  )
  const head = await store.head('file')
  assert.equal(head.objectKey, 'file')
  assert.equal(tokenCalls, 2)
  assert.equal(driveCalls, 2)
})
