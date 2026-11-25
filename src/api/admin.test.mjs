import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectStorageAccount,
  createUser,
  listStorageAccounts,
  listUsers,
  refreshStorageAccount,
  removeStorageAccount,
  resetUserPassword,
  resetUserTotp,
  setStorageAccountStatus,
  setUserDisabled,
} from './admin.ts'

function mockFetch(response, capture) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    capture(input, init)
    return response
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

function adminUser(overrides = {}) {
  return {
    id: '1',
    username: 'demo1',
    role: 'user',
    disabled: 0,
    must_change_password: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  }
}

test('listUsers returns the users array', async () => {
  const users = [adminUser()]
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ users }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await listUsers(), users)
    assert.equal(request.input, '/api/admin/users')
  } finally {
    restore()
  }
})

test('createUser posts username, kdfSalt and authKey', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: adminUser() }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await createUser('demo1', 'salt-b64', 'auth-key-b64'), adminUser())
    assert.equal(request.input, '/api/admin/users')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'demo1', kdfSalt: 'salt-b64', authKey: 'auth-key-b64' })
  } finally {
    restore()
  }
})

test('setUserDisabled uses PATCH and encoded id', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: adminUser({ id: 'user/id', disabled: 1 }) }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await setUserDisabled('user/id', true)
    assert.equal(request.input, '/api/admin/users/user%2Fid')
    assert.equal(request.init.method, 'PATCH')
    assert.deepEqual(JSON.parse(request.init.body), { disabled: true })
  } finally {
    restore()
  }
})

test('resetUserPassword posts kdfSalt and authKey', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: adminUser({ id: 'user/id' }) }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await resetUserPassword('user/id', 'salt-b64', 'auth-key-b64')
    assert.equal(request.input, '/api/admin/users/user%2Fid/password')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { kdfSalt: 'salt-b64', authKey: 'auth-key-b64' })
  } finally {
    restore()
  }
})

test('resetUserTotp uses POST and encoded id', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await resetUserTotp('user/id')
    assert.equal(request.input, '/api/admin/users/user%2Fid/totp/reset')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.body, undefined)
  } finally {
    restore()
  }
})

function storageAccount(overrides = {}) {
  return {
    id: 1,
    googleEmail: 'a@example.com',
    status: 'active',
    quotaTotal: 1000,
    quotaUsed: 500,
    quotaCheckedAt: '2026-01-01T00:00:00.000Z',
    fileCount: 3,
    bytesStored: 400,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('listStorageAccounts returns the accounts array', async () => {
  const accounts = [storageAccount()]
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ accounts }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await listStorageAccounts(), accounts)
    assert.equal(request.input, '/api/admin/storage')
  } finally {
    restore()
  }
})

test('connectStorageAccount posts and returns the OAuth url', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ url: 'https://accounts.google.com/x' }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.equal(await connectStorageAccount(), 'https://accounts.google.com/x')
    assert.equal(request.input, '/api/admin/storage/connect')
    assert.equal(request.init.method, 'POST')
  } finally {
    restore()
  }
})

test('setStorageAccountStatus posts the status', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await setStorageAccountStatus(7, 'readonly')
    assert.equal(request.input, '/api/admin/storage/7/status')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { status: 'readonly' })
  } finally {
    restore()
  }
})

test('refreshStorageAccount posts without a body', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await refreshStorageAccount(2)
    assert.equal(request.input, '/api/admin/storage/2/refresh')
    assert.equal(request.init.method, 'POST')
  } finally {
    restore()
  }
})

test('removeStorageAccount uses DELETE', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await removeStorageAccount(3)
    assert.equal(request.input, '/api/admin/storage/3')
    assert.equal(request.init.method, 'DELETE')
  } finally {
    restore()
  }
})
