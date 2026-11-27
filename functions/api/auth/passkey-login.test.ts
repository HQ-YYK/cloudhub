import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../../_lib/auth.ts'
import { encodeBase64Url } from '../../_lib/webauthn.ts'
import {
  authRepository,
  buildAuthenticatorData,
  buildClientDataJSON,
  buildSignedData,
  bytesToB64,
  credentialIdBytes,
  generateEs256KeyPair,
  generateRs256KeyPair,
  makePasskeyHandlers,
  originRequest,
  passkeyCredential,
  passkeyRepository,
  passkeySessionUser,
  signEs256,
  signRs256,
  userId,
  verifyEnv,
  wrappedMasterKey,
} from './passkey.fixtures.ts'

const rpId = 'cloudhub.test'
const origin = 'https://cloudhub.test'
const FLAG_REGISTER = 0x45
const FLAG_ASSERT = 0x05

const loginUser = { username: 'alice', role: 'user' as const, disabled: 0, must_change_password: 0, wrapped_master_key: wrappedMasterKey }

async function call(handler: unknown, method: string, path: string, body?: unknown, cookie?: string, params?: Record<string, string>) {
  const fn = handler as (context: never) => Response | Promise<Response>
  return fn({ request: originRequest(path, method, body, cookie), env: verifyEnv(), params } as never)
}

async function loginChallenge(handlers: ReturnType<typeof makePasskeyHandlers>) {
  const response = await call(handlers.loginOptions, 'POST', '/api/auth/passkey/login/options', undefined)
  assert.equal(response.status, 200)
  return (await response.json() as { challenge: string }).challenge
}

async function loginBodyFor(
  keyPair: { privateKey: CryptoKey },
  algorithm: number,
  credentialIdB64: string,
  challenge: string,
  signCount: number,
  overrides: Partial<{ clientDataJSON: string, authenticatorData: string, signature: string, userHandle: string }> = {},
) {
  const clientDataJSON = overrides.clientDataJSON ?? buildClientDataJSON({ type: 'webauthn.get', challenge, origin })
  const authenticatorData = overrides.authenticatorData ?? await buildAuthenticatorData({ rpId, flags: FLAG_ASSERT, signCount })
  const signedData = await buildSignedData(authenticatorData, clientDataJSON)
  const signature = overrides.signature ?? (algorithm === -7
    ? await signEs256(keyPair.privateKey, signedData)
    : await signRs256(keyPair.privateKey, signedData))
  return {
    challenge,
    credentialId: credentialIdB64,
    clientDataJSON,
    authenticatorData,
    signature,
    userHandle: overrides.userHandle ?? encodeBase64Url(userId),
  }
}

async function registerPasskey(handlers: ReturnType<typeof makePasskeyHandlers>, keyPair: { publicKeySpki: string, privateKey: CryptoKey }, algorithm: number, label: string) {
  const credentialId = credentialIdBytes(label)
  const credentialIdB64 = bytesToB64(credentialId)
  const registerOptions = await call(handlers.registerOptions, 'POST', '/api/auth/passkey/register/options', undefined, 'cloudhub_session=test-token')
  const registerBody = await registerOptions.json() as { challenge: string }
  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge: registerBody.challenge, origin })
  const authenticatorData = await buildAuthenticatorData({ rpId, flags: FLAG_REGISTER, signCount: 0, credentialId })
  const registerResponse = await call(handlers.registerVerify, 'POST', '/api/auth/passkey/register/verify', {
    challenge: registerBody.challenge,
    credentialId: credentialIdB64,
    clientDataJSON,
    authenticatorData,
    publicKey: keyPair.publicKeySpki,
    publicKeyAlgorithm: algorithm,
    name: label,
  }, 'cloudhub_session=test-token')
  assert.equal(registerResponse.status, 201)
  return credentialIdB64
}

test('login options returns a challenge without authentication', async () => {
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(authRepository(), passkeys)

  const response = await call(handlers.loginOptions, 'POST', '/api/auth/passkey/login/options', undefined)
  assert.equal(response.status, 200)
  const body = await response.json() as { challenge: string, rpId: string, userVerification: string, timeout: number }
  assert.match(body.challenge, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(body.rpId, rpId)
  assert.equal(body.userVerification, 'required')
  assert.equal(body.timeout, 300000)
  assert.equal(passkeys.createdChallenges.length, 1)
  assert.equal(passkeys.createdChallenges[0].purpose, 'login')
  assert.equal(passkeys.createdChallenges[0].userId, null)
})

test('ES256 register then login issues a session and returns null PRF', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository({ loginUser })
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialIdB64 = await registerPasskey(handlers, keyPair, -7, 'es256-login')

  const challenge = await loginChallenge(handlers)
  const body = await loginBodyFor(keyPair, -7, credentialIdB64, challenge, 1)
  const response = await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)
  assert.equal(response.status, 200)
  const parsed = await response.json() as { user: Record<string, unknown>, prfWrappedMasterKey: string | null }
  assert.deepEqual(parsed.user, { id: userId, username: 'alice', role: 'user', mustChangePassword: false, keysReady: true })
  assert.equal(parsed.prfWrappedMasterKey, null)
  assert.equal('totpRequired' in parsed, false)
  assert.match(response.headers.get('Set-Cookie') ?? '', /^cloudhub_session=/)
  assert.equal(auth.sessions.length, 1)
  assert.equal(passkeys.usage.length, 1)
  assert.equal(passkeys.usage[0][1], 1)
})

test('RS256 register then login issues a session', async () => {
  const keyPair = await generateRs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository({ loginUser })
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialIdB64 = await registerPasskey(handlers, keyPair, -257, 'rs256-login')

  const challenge = await loginChallenge(handlers)
  const body = await loginBodyFor(keyPair, -257, credentialIdB64, challenge, 1)
  const response = await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)
  assert.equal(response.status, 200)
  assert.equal(auth.sessions.length, 1)
})

test('login verify rejects wrong rpIdHash, origin, type, missing UV, and crossOrigin', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository()
  const passkeys = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7 })],
    loginUser,
  })
  const handlers = makePasskeyHandlers(auth, passkeys)

  let challenge = await loginChallenge(handlers)
  let body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { authenticatorData: await buildAuthenticatorData({ rpId: 'evil.test', flags: FLAG_ASSERT, signCount: 1 }) })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  challenge = await loginChallenge(handlers)
  body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { clientDataJSON: buildClientDataJSON({ type: 'webauthn.get', challenge, origin: 'https://evil.test' }) })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  challenge = await loginChallenge(handlers)
  body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { clientDataJSON: buildClientDataJSON({ type: 'webauthn.create', challenge, origin }) })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  challenge = await loginChallenge(handlers)
  body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { authenticatorData: await buildAuthenticatorData({ rpId, flags: 0x01, signCount: 1 }) })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  challenge = await loginChallenge(handlers)
  body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { clientDataJSON: buildClientDataJSON({ type: 'webauthn.get', challenge, origin, crossOrigin: true }) })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  assert.equal(auth.loginFailures.length, 5)
})

test('login verify rejects an expired or reused challenge', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository()
  const passkeys = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7 })],
    loginUser,
  })
  const handlers = makePasskeyHandlers(auth, passkeys)

  await passkeys.repository.createWebauthnChallenge({
    id: crypto.randomUUID(),
    userId: null,
    purpose: 'login',
    challengeHash: await sha256('expired'),
    ipHash: 'ip-hash',
    createdAt: '2000-01-01T00:00:00.000Z',
    expiresAt: '2000-01-01T00:05:00.000Z',
  })
  const expiredBody = await loginBodyFor(keyPair, -7, 'credential', 'expired', 1)
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', expiredBody)).status, 401)

  const challenge = await loginChallenge(handlers)
  const reusedBody = await loginBodyFor(keyPair, -7, 'credential', challenge, 1)
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', reusedBody)).status, 200)
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', reusedBody)).status, 401)
})

test('login verify rejects a mismatched userHandle and a disabled user', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository()
  const passkeys = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7 })],
    loginUser,
  })
  const handlers = makePasskeyHandlers(auth, passkeys)

  let challenge = await loginChallenge(handlers)
  let body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { userHandle: encodeBase64Url('other-user') })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  const disabled = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7 })],
    loginUser: { ...loginUser, disabled: 1 },
  })
  const disabledHandlers = makePasskeyHandlers(authRepository(), disabled)
  challenge = await loginChallenge(disabledHandlers)
  body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1)
  assert.equal((await call(disabledHandlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)
})

test('login verify rejects a sign count rollback and allows both-zero', async () => {
  const keyPair = await generateEs256KeyPair()

  const rollback = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7, sign_count: 2 })],
    loginUser,
  })
  const rollbackHandlers = makePasskeyHandlers(authRepository(), rollback)
  let challenge = await loginChallenge(rollbackHandlers)
  let body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1)
  assert.equal((await call(rollbackHandlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)

  const bothZero = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7, sign_count: 0 })],
    loginUser,
  })
  const bothZeroHandlers = makePasskeyHandlers(authRepository(), bothZero)
  challenge = await loginChallenge(bothZeroHandlers)
  body = await loginBodyFor(keyPair, -7, 'credential', challenge, 0)
  assert.equal((await call(bothZeroHandlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 200)
})

test('login verify records failures with the username or the unknown key', async () => {
  const keyPair = await generateEs256KeyPair()
  const ipHash = await sha256('unknown')
  const auth = authRepository()
  const passkeys = passkeyRepository({
    credentials: [passkeyCredential({ id: 'credential', public_key: keyPair.publicKeySpki, algorithm: -7 })],
    loginUser,
  })
  const handlers = makePasskeyHandlers(auth, passkeys)

  let challenge = await loginChallenge(handlers)
  let body = await loginBodyFor(keyPair, -7, 'credential', challenge, 1, { signature: 'garbage-signature' })
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)
  assert.deepEqual(auth.loginFailures[0], ['alice', ipHash])

  challenge = await loginChallenge(handlers)
  body = await loginBodyFor(keyPair, -7, 'missing-credential', challenge, 1)
  assert.equal((await call(handlers.loginVerify, 'POST', '/api/auth/passkey/login/verify', body)).status, 401)
  assert.deepEqual(auth.loginFailures[1], ['passkey:unknown', ipHash])
})
