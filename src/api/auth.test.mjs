import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AuthRequestError,
  changePassword,
  disableTotp,
  enableTotp,
  login,
  setupTotp,
  verifyTotp,
} from './auth.ts'

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

test('changePassword sends POST and reports backend error codes', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (input, init) => {
    request = { input, init }
    return new Response(JSON.stringify({ error: 'weak_password' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await assert.rejects(
      changePassword('old-password', 'new-password'),
      (error) => error instanceof AuthRequestError
        && error.status === 400
        && error.code === 'weak_password',
    )
    assert.equal(request.input, '/api/auth/password')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.init.body), {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('login posts credentials and returns the user when TOTP is off', async () => {
  const user = { id: '1', username: 'alice', role: 'user', mustChangePassword: false }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await login('alice', 'correct-horse-battery'), { user: { ...user, totpEnabled: false } })
    assert.equal(request.input, '/api/auth/login')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'alice', password: 'correct-horse-battery' })
  } finally {
    restore()
  }
})

test('login returns the challenge when TOTP is required', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ totpRequired: true, challenge: 'challenge-token' }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await login('alice', 'correct-horse-battery'), { totpRequired: true, challenge: 'challenge-token' })
    assert.equal(request.input, '/api/auth/login')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'alice', password: 'correct-horse-battery' })
  } finally {
    restore()
  }
})

test('login reports backend error codes', async () => {
  const restore = mockFetch(
    new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    () => {},
  )
  try {
    await assert.rejects(
      login('alice', 'wrong-password'),
      (error) => error instanceof AuthRequestError && error.status === 401 && error.code === 'invalid_credentials',
    )
  } finally {
    restore()
  }
})

test('verifyTotp posts the challenge and numeric code', async () => {
  const user = { id: '1', username: 'alice', role: 'user', mustChangePassword: false }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await verifyTotp('challenge-token', { code: '123456' }), { ...user, totpEnabled: true })
    assert.equal(request.input, '/api/auth/totp/verify')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { challenge: 'challenge-token', code: '123456' })
  } finally {
    restore()
  }
})

test('verifyTotp posts the challenge and recovery code', async () => {
  const user = { id: '1', username: 'alice', role: 'user', mustChangePassword: false }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await verifyTotp('challenge-token', { recoveryCode: 'abcd-efgh' }), { ...user, totpEnabled: true })
    assert.equal(request.input, '/api/auth/totp/verify')
    assert.deepEqual(JSON.parse(request.init.body), { challenge: 'challenge-token', recoveryCode: 'abcd-efgh' })
  } finally {
    restore()
  }
})

test('verifyTotp reports invalid_code', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ error: 'invalid_code' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await assert.rejects(
      verifyTotp('challenge-token', { code: '000000' }),
      (error) => error instanceof AuthRequestError && error.status === 401 && error.code === 'invalid_code',
    )
    assert.equal(request.input, '/api/auth/totp/verify')
  } finally {
    restore()
  }
})

test('setupTotp posts without a body and returns the secret', async () => {
  const payload = { secret: 'test-secret', otpauthUrl: 'otpauth://totp/CloudHub:alice?secret=test-secret' }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await setupTotp(), payload)
    assert.equal(request.input, '/api/auth/totp/setup')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.body, undefined)
  } finally {
    restore()
  }
})

test('enableTotp posts the code and returns recovery codes', async () => {
  const recoveryCodes = ['abcd-efgh', 'ijkl-mnop']
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ recoveryCodes }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await enableTotp('123456'), recoveryCodes)
    assert.equal(request.input, '/api/auth/totp/enable')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { code: '123456' })
  } finally {
    restore()
  }
})

test('disableTotp posts the password and code', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await disableTotp('test-password', '123456')
    assert.equal(request.input, '/api/auth/totp/disable')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { password: 'test-password', code: '123456' })
  } finally {
    restore()
  }
})
