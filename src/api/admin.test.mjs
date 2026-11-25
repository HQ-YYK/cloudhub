import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createUser,
  listUsers,
  resetUserPassword,
  resetUserTotp,
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

test('listUsers returns the users array', async () => {
  const users = [{ id: '1', username: 'demo1', role: 'user', disabled: 0, must_change_password: 1, created_at: '2026-01-01', updated_at: '2026-01-01' }]
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

test('createUser posts username and password', async () => {
  const user = { id: '1', username: 'demo1', role: 'user', disabled: 0, must_change_password: 1, created_at: '2026-01-01', updated_at: '2026-01-01' }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await createUser('demo1', 'temporary-password'), user)
    assert.equal(request.input, '/api/admin/users')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'demo1', password: 'temporary-password' })
  } finally {
    restore()
  }
})

test('setUserDisabled uses PATCH and encoded id', async () => {
  const user = { id: 'user/id', username: 'demo1', role: 'user', disabled: 1, must_change_password: 0, created_at: '2026-01-01', updated_at: '2026-01-01' }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user }), { headers: { 'Content-Type': 'application/json' } }),
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

test('resetUserPassword uses POST and encoded id', async () => {
  const user = { id: 'user/id', username: 'demo1', role: 'user', disabled: 0, must_change_password: 1, created_at: '2026-01-01', updated_at: '2026-01-01' }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await resetUserPassword('user/id', 'temporary-password')
    assert.equal(request.input, '/api/admin/users/user%2Fid/password')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { password: 'temporary-password' })
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
