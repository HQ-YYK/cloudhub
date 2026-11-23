import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { StorageRepository, StorageAccount, OAuthState } from '../../_lib/storage-repository.ts'
import { createStorageConnectHandler } from './connect.ts'
import { createStorageCallbackHandler } from './callback.ts'

function authRepository(role: 'admin' | 'user', mustChangePassword = false, authenticated = true): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => authenticated
      ? { session_id: 'session', id: 'user-1', username: 'test', role, must_change_password: mustChangePassword ? 1 : 0 }
      : null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async () => undefined,
  }
}

function storageRepository(options: {
  state?: OAuthState | null
  account?: StorageAccount | null
} = {}) {
  let createdStateHash = ''
  let deletedAccount = false
  let upserted: StorageAccount | null = null
  const repository: StorageRepository = {
    getAccount: async () => options.account ?? null,
    upsertAccount: async (account) => { upserted = account },
    deleteAccount: async () => { deletedAccount = true },
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async (stateHash) => { createdStateHash = stateHash },
    consumeOAuthState: async () => {
      const state = options.state ?? null
      options.state = null
      return state
    },
    findAdminUserById: async () => ({
      id: 'user-1',
      role: 'admin',
      disabled: 0,
      must_change_password: 0,
    }),
  }
  return {
    repository,
    get createdStateHash() { return createdStateHash },
    get deletedAccount() { return deletedAccount },
    get upserted() { return upserted },
  }
}

function env() {
  return {
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    STORAGE_ENCRYPTION_KEY: Buffer.from('5'.repeat(32), 'ascii').toString('base64url'),
  }
}

test('storage connect requires admin and stores a state hash', async () => {
  const ordinary = storageRepository()
  let handler = createStorageConnectHandler({
    createAuthRepository: () => authRepository('user'),
    createStorageRepository: () => ordinary.repository,
  })
  let response = await handler({
    request: new Request('https://cloudhub.test/api/storage/connect', { headers: { Cookie: 'cloudhub_session=valid' } }),
    env: env(),
  } as never)
  assert.equal(response.status, 403)

  const admin = storageRepository()
  handler = createStorageConnectHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => admin.repository,
  })
  response = await handler({
    request: new Request('https://cloudhub.test/api/storage/connect', { headers: { Cookie: 'cloudhub_session=valid' } }),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('Location')!)
  assert.equal(location.origin, 'https://accounts.google.com')
  assert.equal(location.searchParams.get('client_id'), 'client')
  assert.equal(location.searchParams.get('redirect_uri'), 'https://cloudhub.test/api/storage/callback')
  assert.equal(location.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.file')
  assert.ok(location.searchParams.get('state'))
  assert.notEqual(admin.createdStateHash, location.searchParams.get('state'))
  assert.equal(admin.createdStateHash.length, 43)
})

test('storage callback rejects missing or expired state and denied authorization', async () => {
  const missing = createStorageCallbackHandler({
    createStorageRepository: () => storageRepository({ state: null }).repository,
  })
  let response = await missing({
    request: new Request('https://cloudhub.test/api/storage/callback?state=missing'),
    env: env(),
  } as never)
  assert.equal(response.status, 400)

  const deniedState = storageRepository({
    state: { state_hash: 'hash', user_id: 'user-1', expires_at: '2030-01-01T00:00:00.000Z' },
  })
  const denied = createStorageCallbackHandler({
    createStorageRepository: () => deniedState.repository,
  })
  response = await denied({
    request: new Request('https://cloudhub.test/api/storage/callback?state=valid&error=access_denied'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?storage=denied')
  response = await denied({
    request: new Request('https://cloudhub.test/api/storage/callback?state=valid&error=access_denied'),
    env: env(),
  } as never)
  assert.equal(response.status, 400)
})

test('storage callback fails without refresh token and saves ciphertext on success', async () => {
  function idToken(email: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
    return `${header}.${payload}.signature`
  }

  const noRefresh = createStorageCallbackHandler({
    createStorageRepository: () => storageRepository({
      state: { state_hash: 'hash', user_id: 'user-1', expires_at: '2030-01-01T00:00:00.000Z' },
    }).repository,
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: 'access',
      id_token: idToken('test@example.com'),
    }), { status: 200 }),
  })
  let response = await noRefresh({
    request: new Request('https://cloudhub.test/api/storage/callback?state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?storage=failed')

  const current = storageRepository({
    state: { state_hash: 'hash', user_id: 'user-1', expires_at: '2030-01-01T00:00:00.000Z' },
  })
  const success = createStorageCallbackHandler({
    createStorageRepository: () => current.repository,
    fetchImpl: async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({
          refresh_token: 'plain-refresh-token',
          access_token: 'access',
          id_token: idToken('test@example.com'),
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'folder-1' }), { status: 200 })
    },
  })
  response = await success({
    request: new Request('https://cloudhub.test/api/storage/callback?state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?storage=connected')
  assert.ok(current.upserted)
  assert.notEqual(current.upserted?.refresh_token_ciphertext, 'plain-refresh-token')
})

test('storage callback reuses an existing accessible root folder', async () => {
  function idToken(email: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
    return `${header}.${payload}.signature`
  }
  const account: StorageAccount = {
    id: 1,
    google_email: 'old@example.com',
    refresh_token_ciphertext: 'ciphertext',
    refresh_token_iv: 'iv',
    root_folder_id: 'old-folder',
    connected_by: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  const current = storageRepository({
    account,
    state: { state_hash: 'hash', user_id: 'user-1', expires_at: '2030-01-01T00:00:00.000Z' },
  })
  let folderCreateCalls = 0
  const handler = createStorageCallbackHandler({
    createStorageRepository: () => current.repository,
    fetchImpl: async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({
          refresh_token: 'plain-refresh-token',
          access_token: 'access',
          id_token: idToken('test@example.com'),
        }), { status: 200 })
      }
      if (String(input).includes('/files/old-folder')) {
        return new Response(JSON.stringify({ id: 'old-folder', trashed: false }), { status: 200 })
      }
      folderCreateCalls += 1
      return new Response(JSON.stringify({ id: 'new-folder' }), { status: 200 })
    },
  })
  const response = await handler({
    request: new Request('https://cloudhub.test/api/storage/callback?state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?storage=connected')
  assert.equal(folderCreateCalls, 0)
  assert.equal(current.upserted?.root_folder_id, 'old-folder')
})
