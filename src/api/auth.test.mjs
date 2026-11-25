import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AuthRequestError,
  changePassword,
  disableTotp,
  enableTotp,
  getKeys,
  login,
  prelogin,
  regenerateRecoveryKey,
  resetKeys,
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

function baseUser(overrides = {}) {
  return {
    id: '1',
    username: 'alice',
    role: 'user',
    mustChangePassword: false,
    legacy: false,
    keysReady: true,
    ...overrides,
  }
}

test('prelogin posts the username and reports a legacy account', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ legacy: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await prelogin('alice'), { legacy: true })
    assert.equal(request.input, '/api/auth/prelogin')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'alice' })
  } finally {
    restore()
  }
})

test('prelogin returns kdf parameters for a new-format account', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ legacy: false, kdfSalt: 'salt-b64', kdfIterations: 600000 }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await prelogin('alice'), { legacy: false, kdfSalt: 'salt-b64', kdfIterations: 600000 })
    assert.equal(request.input, '/api/auth/prelogin')
  } finally {
    restore()
  }
})

test('login posts an authKey credential and returns the user when TOTP is off', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: baseUser() }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await login({ username: 'alice', authKey: 'auth-key-b64' }), { user: { ...baseUser(), totpEnabled: false } })
    assert.equal(request.input, '/api/auth/login')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'alice', authKey: 'auth-key-b64' })
  } finally {
    restore()
  }
})

test('login posts a password credential for a legacy account', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: baseUser({ legacy: true }) }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await login({ username: 'alice', password: 'correct-horse' })
    assert.deepEqual(JSON.parse(request.init.body), { username: 'alice', password: 'correct-horse' })
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
    assert.deepEqual(await login({ username: 'alice', authKey: 'auth-key-b64' }), { totpRequired: true, challenge: 'challenge-token' })
    assert.equal(request.input, '/api/auth/login')
    assert.deepEqual(JSON.parse(request.init.body), { username: 'alice', authKey: 'auth-key-b64' })
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
      login({ username: 'alice', password: 'wrong-password' }),
      (error) => error instanceof AuthRequestError && error.status === 401 && error.code === 'invalid_credentials',
    )
  } finally {
    restore()
  }
})

test('getKeys returns the keys payload', async () => {
  const payload = { legacy: false, kdfSalt: 'salt-b64', kdfIterations: 600000, wrappedMasterKey: 'wrapped-mk', recoveryWrappedKey: 'wrapped-recovery' }
  let request
  const restore = mockFetch(
    new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await getKeys(), payload)
    assert.equal(request.input, '/api/auth/keys')
    assert.equal(request.init.method, undefined)
  } finally {
    restore()
  }
})

test('changePassword sends the new password body', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await changePassword({
      currentAuthKey: 'current-auth',
      newKdfSalt: 'new-salt',
      newAuthKey: 'new-auth',
      wrappedMasterKey: 'wrapped-mk',
      recoveryWrappedKey: 'wrapped-recovery',
    })
    assert.equal(request.input, '/api/auth/password')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), {
      currentAuthKey: 'current-auth',
      newKdfSalt: 'new-salt',
      newAuthKey: 'new-auth',
      wrappedMasterKey: 'wrapped-mk',
      recoveryWrappedKey: 'wrapped-recovery',
    })
  } finally {
    restore()
  }
})

test('regenerateRecoveryKey sends the current auth key and new recovery key', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await regenerateRecoveryKey({ currentAuthKey: 'current-auth', recoveryWrappedKey: 'wrapped-recovery' })
    assert.equal(request.input, '/api/auth/keys/recovery')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { currentAuthKey: 'current-auth', recoveryWrappedKey: 'wrapped-recovery' })
  } finally {
    restore()
  }
})

test('resetKeys sends the reset body', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await resetKeys({
      currentAuthKey: 'current-auth',
      newKdfSalt: 'new-salt',
      newAuthKey: 'new-auth',
      wrappedMasterKey: 'wrapped-mk',
      recoveryWrappedKey: 'wrapped-recovery',
    })
    assert.equal(request.input, '/api/auth/keys/reset')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), {
      currentAuthKey: 'current-auth',
      newKdfSalt: 'new-salt',
      newAuthKey: 'new-auth',
      wrappedMasterKey: 'wrapped-mk',
      recoveryWrappedKey: 'wrapped-recovery',
    })
  } finally {
    restore()
  }
})

test('disableTotp posts the authKey and code', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    await disableTotp({ authKey: 'auth-key-b64' }, '123456')
    assert.equal(request.input, '/api/auth/totp/disable')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { authKey: 'auth-key-b64', code: '123456' })
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
    await disableTotp({ password: 'test-password' }, '123456')
    assert.deepEqual(JSON.parse(request.init.body), { password: 'test-password', code: '123456' })
  } finally {
    restore()
  }
})

test('verifyTotp posts the challenge and numeric code', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: baseUser() }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await verifyTotp('challenge-token', { code: '123456' }), { ...baseUser(), totpEnabled: true })
    assert.equal(request.input, '/api/auth/totp/verify')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { challenge: 'challenge-token', code: '123456' })
  } finally {
    restore()
  }
})

test('verifyTotp posts the challenge and recovery code', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ user: baseUser() }), { headers: { 'Content-Type': 'application/json' } }),
    (input, init) => { request = { input, init } },
  )
  try {
    assert.deepEqual(await verifyTotp('challenge-token', { recoveryCode: 'abcd-efgh' }), { ...baseUser(), totpEnabled: true })
    assert.deepEqual(JSON.parse(request.init.body), { challenge: 'challenge-token', recoveryCode: 'abcd-efgh' })
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
