import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthRequestError } from './auth.ts'
import {
  deletePasskey,
  getPasskeyLoginOptions,
  getPasskeyRegisterOptions,
  listPasskeys,
  renamePasskey,
  setPasskeyPrf,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
} from './passkeys.ts'

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function baseUser(overrides = {}) {
  return {
    id: '1',
    username: 'alice',
    role: 'user',
    mustChangePassword: false,
    keysReady: true,
    ...overrides,
  }
}

test('getPasskeyRegisterOptions posts to the register options endpoint', async () => {
  const payload = {
    challenge: 'challenge-token',
    rp: { id: 'localhost', name: 'CloudHub' },
    user: { id: 'dXNlcg', name: 'alice', displayName: 'alice' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
    timeout: 300000,
  }
  let request
  const restore = mockFetch(jsonResponse(payload), (input, init) => { request = { input, init } })
  try {
    assert.deepEqual(await getPasskeyRegisterOptions(), payload)
    assert.equal(request.input, '/api/auth/passkey/register/options')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.body, undefined)
  } finally {
    restore()
  }
})

test('verifyPasskeyRegistration posts the credential body and returns the passkey', async () => {
  const passkey = { id: 'cred-id', name: 'Passkey', createdAt: 'now', lastUsedAt: null, prf: false }
  const body = {
    challenge: 'challenge-token',
    credentialId: 'cred-id',
    clientDataJSON: 'client-data',
    authenticatorData: 'auth-data',
    publicKey: 'spki',
    publicKeyAlgorithm: -7,
    name: 'Passkey',
  }
  let request
  const restore = mockFetch(jsonResponse({ passkey }, 201), (input, init) => { request = { input, init } })
  try {
    assert.deepEqual(await verifyPasskeyRegistration(body), { passkey })
    assert.equal(request.input, '/api/auth/passkey/register/verify')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), body)
  } finally {
    restore()
  }
})

test('setPasskeyPrf posts the wrapped key and does not parse the 204 body', async () => {
  let request
  const restore = mockFetch(new Response(null, { status: 204 }), (input, init) => { request = { input, init } })
  try {
    assert.equal(await setPasskeyPrf('cred/id', 'wrapped-mk'), undefined)
    assert.equal(request.input, '/api/auth/passkey/cred%2Fid/prf')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { prfWrappedMasterKey: 'wrapped-mk' })
  } finally {
    restore()
  }
})

test('getPasskeyLoginOptions posts to the login options endpoint', async () => {
  const payload = { challenge: 'challenge-token', rpId: 'localhost', userVerification: 'required', timeout: 300000 }
  let request
  const restore = mockFetch(jsonResponse(payload), (input, init) => { request = { input, init } })
  try {
    assert.deepEqual(await getPasskeyLoginOptions(), payload)
    assert.equal(request.input, '/api/auth/passkey/login/options')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.body, undefined)
  } finally {
    restore()
  }
})

test('verifyPasskeyLogin posts the assertion body and returns user plus wrapped key', async () => {
  const body = {
    challenge: 'challenge-token',
    credentialId: 'cred-id',
    clientDataJSON: 'client-data',
    authenticatorData: 'auth-data',
    signature: 'signature',
    userHandle: 'dXNlcg',
  }
  let request
  const restore = mockFetch(jsonResponse({ user: baseUser(), prfWrappedMasterKey: 'wrapped-mk' }), (input, init) => {
    request = { input, init }
  })
  try {
    assert.deepEqual(await verifyPasskeyLogin(body), { user: baseUser(), prfWrappedMasterKey: 'wrapped-mk' })
    assert.equal(request.input, '/api/auth/passkey/login/verify')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), body)
  } finally {
    restore()
  }
})

test('verifyPasskeyLogin returns null wrapped key when the server has none', async () => {
  const body = {
    challenge: 'challenge-token',
    credentialId: 'cred-id',
    clientDataJSON: 'client-data',
    authenticatorData: 'auth-data',
    signature: 'signature',
    userHandle: 'dXNlcg',
  }
  const restore = mockFetch(jsonResponse({ user: baseUser(), prfWrappedMasterKey: null }), () => {})
  try {
    assert.deepEqual(await verifyPasskeyLogin(body), { user: baseUser(), prfWrappedMasterKey: null })
  } finally {
    restore()
  }
})

test('listPasskeys fetches the passkey list', async () => {
  const passkeys = [{ id: 'cred-id', name: '我的电脑', createdAt: 'now', lastUsedAt: null, prf: true }]
  let request
  const restore = mockFetch(jsonResponse({ passkeys }), (input, init) => { request = { input, init } })
  try {
    assert.deepEqual(await listPasskeys(), passkeys)
    assert.equal(request.input, '/api/auth/passkey')
    assert.equal(request.init.method, undefined)
  } finally {
    restore()
  }
})

test('renamePasskey patches the name for the encoded credential id', async () => {
  let request
  const restore = mockFetch(jsonResponse({ ok: true }), (input, init) => { request = { input, init } })
  try {
    await renamePasskey('cred/id', '工作电脑')
    assert.equal(request.input, '/api/auth/passkey/cred%2Fid')
    assert.equal(request.init.method, 'PATCH')
    assert.deepEqual(JSON.parse(request.init.body), { name: '工作电脑' })
  } finally {
    restore()
  }
})

test('deletePasskey deletes the encoded credential id without parsing the 204 body', async () => {
  let request
  const restore = mockFetch(new Response(null, { status: 204 }), (input, init) => { request = { input, init } })
  try {
    assert.equal(await deletePasskey('cred/id'), undefined)
    assert.equal(request.input, '/api/auth/passkey/cred%2Fid')
    assert.equal(request.init.method, 'DELETE')
  } finally {
    restore()
  }
})

test('passkey endpoints report backend error codes', async () => {
  const restore = mockFetch(jsonResponse({ error: 'invalid_credentials' }, 401), () => {})
  try {
    await assert.rejects(
      verifyPasskeyLogin({ challenge: 'c', credentialId: 'id', clientDataJSON: 'd', authenticatorData: 'a', signature: 's', userHandle: 'u' }),
      (error) => error instanceof AuthRequestError && error.status === 401 && error.code === 'invalid_credentials',
    )
  } finally {
    restore()
  }
})

test('a 429 HTML platform page is classified as platform_limited', async () => {
  const restore = mockFetch(new Response('<html>error 1027</html>', { status: 429, headers: { 'Content-Type': 'text/html' } }), () => {})
  try {
    await assert.rejects(
      listPasskeys(),
      (error) => error instanceof AuthRequestError && error.status === 429 && error.code === 'platform_limited',
    )
  } finally {
    restore()
  }
})
