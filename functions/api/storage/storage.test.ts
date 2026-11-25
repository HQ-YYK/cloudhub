import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database, PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type {
  StorageAccount,
  StorageAccountStatus,
  StorageAccountWithStats,
  StorageRepository,
} from '../../_lib/storage-repository.ts'
import { MAX_STORAGE_ACCOUNTS } from '../../_lib/storage-repository.ts'
import { createAdminStorageHandler } from '../admin/storage/index.ts'
import { createAdminStorageDeleteHandler } from '../admin/storage/[id]/index.ts'
import { createAdminStorageStatusHandler } from '../admin/storage/[id]/status.ts'
import { createStorageCallbackHandler } from './callback.ts'
import { createStorageStatusHandler } from './status.ts'

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

function accountView(options: Partial<StorageAccountWithStats> = {}): StorageAccountWithStats {
  return {
    id: 1,
    google_email: 'a@example.com',
    refresh_token_ciphertext: 'ciphertext',
    refresh_token_iv: 'iv',
    root_folder_id: 'root',
    connected_by: 'user-1',
    status: 'active',
    quota_total: 1000,
    quota_used: 500,
    quota_checked_at: '2030-01-01T00:00:00.000Z',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    file_count: 3,
    bytes_stored: 400,
    ...options,
  }
}

function createRepo(overrides: Partial<StorageRepository> = {}) {
  const created: StorageAccount[] = []
  const updated: Array<{ id: number; status: StorageAccountStatus }> = []
  const state = {
    statusSet: null as { id: number; status: StorageAccountStatus } | null,
    deletedId: null as number | null,
    createdStateHash: '',
  }

  const repository: StorageRepository = {
    getAccount: async () => null,
    listAccounts: async () => [],
    listAccountsWithStats: async () => [],
    countAccounts: async () => 0,
    findAccountByEmail: async () => null,
    createAccount: async (input) => {
      const account: StorageAccount = {
        id: 2,
        google_email: input.googleEmail,
        refresh_token_ciphertext: input.refreshTokenCiphertext,
        refresh_token_iv: input.refreshTokenIv,
        root_folder_id: input.rootFolderId,
        connected_by: input.connectedBy,
        status: 'active',
        quota_total: null,
        quota_used: null,
        quota_checked_at: null,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      }
      created.push(account)
      return account
    },
    updateAccountTokens: async (id, _email, _ciphertext, _iv, _by, status) => {
      updated.push({ id, status })
      return null
    },
    setAccountStatus: async (id, status) => {
      state.statusSet = { id, status }
      return accountView({ id, status })
    },
    setAccountReauth: async () => undefined,
    setAccountQuota: async () => undefined,
    deleteAccount: async (id) => { state.deletedId = id },
    countFilesByAccount: async () => 0,
    pendingBytesByAccount: async () => 0,
    findUserFolder: async () => null,
    setUserFolderIfEmpty: async () => false,
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async (stateHash) => { state.createdStateHash = stateHash },
    consumeOAuthState: async () => ({ state_hash: 'hash', user_id: 'user-1', expires_at: '2030-01-01T00:00:00.000Z' }),
    findAdminUserById: async () => ({ id: 'user-1', role: 'admin', disabled: 0, must_change_password: 0 }),
    ...overrides,
  }

  return { repository, created, updated, state }
}

function env() {
  return {
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    STORAGE_ENCRYPTION_KEY: Buffer.from('5'.repeat(32), 'ascii').toString('base64url'),
  }
}

function request(method: string, path: string, headers: Record<string, string> = {}) {
  return new Request(`https://cloudhub.test${path}`, {
    method,
    headers: {
      Origin: 'https://cloudhub.test',
      Cookie: 'cloudhub_session=valid-token',
      ...headers,
    },
  })
}

function run(handler: PagesFunction<AuthEnv>, method: string, path: string, params: Record<string, string> = {}) {
  return handler({ request: request(method, path), env: env(), params } as never)
}

test('admin storage GET lists accounts and rejects non-admins', async () => {
  const repo = createRepo({
    listAccountsWithStats: async () => [accountView(), accountView({ id: 2, google_email: 'b@example.com', status: 'readonly' })],
  })
  const handler = createAdminStorageHandler({
    createAuthRepository: () => authRepository('user'),
    createStorageRepository: () => repo.repository,
  })
  assert.equal((await run(handler, 'GET', '/api/admin/storage')).status, 403)

  const admin = createAdminStorageHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => repo.repository,
  })
  const response = await run(admin, 'GET', '/api/admin/storage')
  assert.equal(response.status, 200)
  const body = await response.json() as { accounts: Array<{ id: number; googleEmail: string; status: string; fileCount: number }> }
  assert.equal(body.accounts.length, 2)
  assert.equal(body.accounts[0].googleEmail, 'a@example.com')
  assert.equal(body.accounts[0].fileCount, 3)
  assert.equal(body.accounts[1].status, 'readonly')
})

test('admin storage connect returns an OAuth url and blocks the 11th account', async () => {
  const repo = createRepo()
  const handler = createAdminStorageHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => repo.repository,
  })
  const response = await run(handler, 'POST', '/api/admin/storage/connect')
  assert.equal(response.status, 200)
  const body = await response.json() as { url: string }
  const authorize = new URL(body.url)
  assert.equal(authorize.origin, 'https://accounts.google.com')
  assert.equal(authorize.searchParams.get('client_id'), 'client')
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://cloudhub.test/api/storage/callback')
  assert.equal(authorize.searchParams.get('prompt'), 'select_account consent')
  assert.ok(authorize.searchParams.get('state'))
  assert.notEqual(repo.state.createdStateHash, authorize.searchParams.get('state'))
  assert.equal(repo.state.createdStateHash.length, 43)

  const full = createRepo({ countAccounts: async () => MAX_STORAGE_ACCOUNTS })
  const blocked = createAdminStorageHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => full.repository,
  })
  assert.equal((await run(blocked, 'POST', '/api/admin/storage/connect')).status, 400)
})

test('admin storage delete blocks accounts with files and removes empty ones', async () => {
  const repo = createRepo({
    getAccount: async (id) => accountView({ id }),
    countFilesByAccount: async () => 3,
  })
  const handler = createAdminStorageDeleteHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => repo.repository,
  })
  const busy = await run(handler, 'DELETE', '/api/admin/storage/1', { id: '1' })
  assert.equal(busy.status, 409)
  assert.equal((await busy.json() as { error: string }).error, 'account_in_use')

  const empty = createRepo({ getAccount: async (id) => accountView({ id }) })
  const remove = createAdminStorageDeleteHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => empty.repository,
  })
  assert.equal((await run(remove, 'DELETE', '/api/admin/storage/1', { id: '1' })).status, 200)
  assert.equal(empty.state.deletedId, 1)

  const forbidden = createAdminStorageDeleteHandler({
    createAuthRepository: () => authRepository('user'),
    createStorageRepository: () => repo.repository,
  })
  assert.equal((await run(forbidden, 'DELETE', '/api/admin/storage/1', { id: '1' })).status, 403)
})

test('admin storage status only accepts active or readonly', async () => {
  const repo = createRepo()
  const handler = createAdminStorageStatusHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => repo.repository,
  })
  const invalid = new Request('https://cloudhub.test/api/admin/storage/1/status', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', Cookie: 'cloudhub_session=valid' },
    body: JSON.stringify({ status: 'bogus' }),
  })
  assert.equal((await handler({ request: invalid, env: env(), params: { id: '1' } } as never)).status, 400)

  const valid = new Request('https://cloudhub.test/api/admin/storage/1/status', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', Cookie: 'cloudhub_session=valid' },
    body: JSON.stringify({ status: 'readonly' }),
  })
  assert.equal((await handler({ request: valid, env: env(), params: { id: '1' } } as never)).status, 200)
  assert.deepEqual(repo.state.statusSet, { id: 1, status: 'readonly' })
})

function idToken(email: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `${header}.${payload}.signature`
}

function callbackRequest(search: string) {
  return new Request(`https://cloudhub.test/api/storage/callback?${search}`)
}

test('storage callback creates a new account with a CloudHub folder', async () => {
  const repo = createRepo()
  const handler = createStorageCallbackHandler({
    createStorageRepository: () => repo.repository,
    fetchImpl: async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({
          refresh_token: 'test-refresh-token',
          access_token: 'access',
          id_token: idToken('new@example.com'),
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'new-folder' }), { status: 200 })
    },
  })
  const response = await handler({
    request: callbackRequest('state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?module=admin-storage&storage=connected')
  assert.equal(repo.created.length, 1)
  assert.equal(repo.created[0].google_email, 'new@example.com')
  assert.equal(repo.created[0].root_folder_id, 'new-folder')
})

test('storage callback reactivates reauth accounts and keeps readonly unchanged', async () => {
  const reauth = createRepo({
    findAccountByEmail: async () => accountView({ status: 'reauth' }),
  })
  const handler = createStorageCallbackHandler({
    createStorageRepository: () => reauth.repository,
    fetchImpl: async () => new Response(JSON.stringify({
      refresh_token: 'test-refresh-token',
      access_token: 'access',
      id_token: idToken('existing@example.com'),
    }), { status: 200 }),
  })
  const response = await handler({
    request: callbackRequest('state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?module=admin-storage&storage=connected')
  assert.equal(reauth.updated.length, 1)
  assert.deepEqual(reauth.updated[0], { id: 1, status: 'active' })

  const readonly = createRepo({
    findAccountByEmail: async () => accountView({ status: 'readonly' }),
  })
  const readonlyHandler = createStorageCallbackHandler({
    createStorageRepository: () => readonly.repository,
    fetchImpl: async () => new Response(JSON.stringify({
      refresh_token: 'test-refresh-token',
      access_token: 'access',
      id_token: idToken('existing@example.com'),
    }), { status: 200 }),
  })
  await readonlyHandler({
    request: callbackRequest('state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.deepEqual(readonly.updated[0], { id: 1, status: 'readonly' })
})

test('storage callback redirects errors and blocks the 11th new account', async () => {
  const denied = createRepo()
  const deniedHandler = createStorageCallbackHandler({
    createStorageRepository: () => denied.repository,
  })
  let response = await deniedHandler({
    request: callbackRequest('state=valid&error=access_denied'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?module=admin-storage&storage_error=denied')

  const full = createRepo({ countAccounts: async () => MAX_STORAGE_ACCOUNTS })
  const fullHandler = createStorageCallbackHandler({
    createStorageRepository: () => full.repository,
    fetchImpl: async () => new Response(JSON.stringify({
      refresh_token: 'test-refresh-token',
      access_token: 'access',
      id_token: idToken('new@example.com'),
    }), { status: 200 }),
  })
  response = await fullHandler({
    request: callbackRequest('state=valid&code=authorization-code'),
    env: env(),
  } as never)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), '/?module=admin-storage&storage_error=too_many_accounts')
})

test('storage status reports connected when at least one account is active', async () => {
  const active = createRepo({
    listAccounts: async () => [accountView({ status: 'readonly' }), accountView({ id: 2, status: 'active' })],
  })
  const activeHandler = createStorageStatusHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => active.repository,
  })
  let response = await run(activeHandler, 'GET', '/api/storage/status')
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { connected: boolean }).connected, true)

  const none = createRepo({
    listAccounts: async () => [accountView({ status: 'readonly' })],
  })
  const noneHandler = createStorageStatusHandler({
    createAuthRepository: () => authRepository('admin'),
    createStorageRepository: () => none.repository,
  })
  response = await run(noneHandler, 'GET', '/api/storage/status')
  assert.equal((await response.json() as { connected: boolean }).connected, false)
})
