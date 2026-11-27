import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../../_lib/auth.ts'
import { createListPasskeysHandler } from './passkey/index.ts'
import { createPasskeyIdHandler } from './passkey/[id].ts'
import { createPasskeyPrfHandler } from './passkey/[id]/prf.ts'
import { createPasskeyRegisterOptionsHandler } from './passkey/register/options.ts'
import {
  authRepository,
  bytesToB64,
  buildAuthenticatorData,
  buildClientDataJSON,
  credentialIdBytes,
  generateEs256KeyPair,
  makePasskeyHandlers,
  originRequest,
  passkeyCredential,
  passkeyRepository,
  passkeySessionUser,
  prfWrappedKey,
  userId,
  verifyEnv,
} from './passkey.fixtures.ts'

const rpId = 'cloudhub.test'
const origin = 'https://cloudhub.test'
const FLAG_REGISTER = 0x45

async function call(handler: unknown, method: string, path: string, body?: unknown, cookie?: string, params?: Record<string, string>) {
  const fn = handler as (context: never) => Response | Promise<Response>
  return fn({ request: originRequest(path, method, body, cookie), env: verifyEnv(), params } as never)
}

async function seedRegisterChallenge(passkeys: ReturnType<typeof passkeyRepository>, challenge: string, userIdOverride?: string, expiresAt?: string) {
  await passkeys.repository.createWebauthnChallenge({
    id: crypto.randomUUID(),
    userId: userIdOverride ?? userId,
    purpose: 'register',
    challengeHash: await sha256(challenge),
    ipHash: 'ip-hash',
    createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt: expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  })
}

async function registerMaterials(keyPair: { publicKeySpki: string, privateKey: CryptoKey }, challenge: string, credentialId: Uint8Array, algorithm: number) {
  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge, origin })
  const authenticatorData = await buildAuthenticatorData({ rpId, flags: FLAG_REGISTER, signCount: 0, credentialId })
  return {
    challenge,
    credentialId: bytesToB64(credentialId),
    clientDataJSON,
    authenticatorData,
    publicKey: keyPair.publicKeySpki,
    publicKeyAlgorithm: algorithm,
    name: 'Test',
  }
}

test('register options returns the creation parameters', async () => {
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handler = createPasskeyRegisterOptionsHandler({
    createAuthRepository: () => auth.repository,
    createPasskeyRepository: () => passkeys.repository,
  })

  const response = await call(handler, 'POST', '/api/auth/passkey/register/options', undefined, 'cloudhub_session=test-token')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    challenge: string
    rp: { id: string, name: string }
    user: { id: string, name: string, displayName: string }
    pubKeyCredParams: Array<{ alg: number }>
    authenticatorSelection: { residentKey: string, userVerification: string }
    attestation: string
    timeout: number
  }
  assert.match(body.challenge, /^[A-Za-z0-9_-]{43}$/u)
  assert.deepEqual(body.rp, { id: rpId, name: 'CloudHub' })
  assert.equal(body.user.name, 'alice')
  assert.equal(body.user.displayName, 'alice')
  assert.deepEqual(body.pubKeyCredParams, [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }])
  assert.deepEqual(body.authenticatorSelection, { residentKey: 'required', userVerification: 'required' })
  assert.equal(body.attestation, 'none')
  assert.equal(body.timeout, 300000)
  assert.equal(passkeys.createdChallenges.length, 1)
  assert.equal(passkeys.createdChallenges[0].purpose, 'register')
})

test('register options requires authentication, a non-forced account, and ready keys', async () => {
  const anonymous = authRepository({ sessionUser: null })
  const handler = createPasskeyRegisterOptionsHandler({
    createAuthRepository: () => anonymous.repository,
    createPasskeyRepository: () => passkeyRepository().repository,
  })
  assert.equal((await call(handler, 'POST', '/api/auth/passkey/register/options', undefined, 'cloudhub_session=test-token')).status, 401)

  const forced = authRepository({ sessionUser: { ...passkeySessionUser, must_change_password: 1 } })
  const forcedHandler = createPasskeyRegisterOptionsHandler({
    createAuthRepository: () => forced.repository,
    createPasskeyRepository: () => passkeyRepository().repository,
  })
  assert.equal((await call(forcedHandler, 'POST', '/api/auth/passkey/register/options', undefined, 'cloudhub_session=test-token')).status, 403)

  const noKeys = authRepository({ sessionUser: { ...passkeySessionUser, wrapped_master_key: null } })
  const noKeysHandler = createPasskeyRegisterOptionsHandler({
    createAuthRepository: () => noKeys.repository,
    createPasskeyRepository: () => passkeyRepository().repository,
  })
  assert.equal((await call(noKeysHandler, 'POST', '/api/auth/passkey/register/options', undefined, 'cloudhub_session=test-token')).status, 409)
})

test('register options returns 409 when the user already has 10 passkeys', async () => {
  const credentials = Array.from({ length: 10 }, (_, index) => passkeyCredential({ id: `credential-${index}`, created_at: `2030-01-01T00:00:0${index}.000Z` }))
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository({ credentials })
  const handler = createPasskeyRegisterOptionsHandler({
    createAuthRepository: () => auth.repository,
    createPasskeyRepository: () => passkeys.repository,
  })

  const response = await call(handler, 'POST', '/api/auth/passkey/register/options', undefined, 'cloudhub_session=test-token')
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'passkey_limit' })
})

test('register verify stores an ES256 passkey and returns 201', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('es256-credential')
  await seedRegisterChallenge(passkeys, 'register-challenge')
  const body = await registerMaterials(keyPair, 'register-challenge', credentialId, -7)

  const response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', { ...body, name: 'MacBook' }, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 201)
  const parsed = await response.json() as { passkey: { id: string, name: string, createdAt: string, lastUsedAt: null, prf: boolean } }
  assert.deepEqual(parsed.passkey, { id: body.credentialId, name: 'MacBook', createdAt: parsed.passkey.createdAt, lastUsedAt: null, prf: false })
  assert.equal(passkeys.created.length, 1)
  assert.equal(passkeys.created[0].algorithm, -7)
  assert.equal(passkeys.consumed.length, 1)
})

test('register verify rejects an unsupported algorithm', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('bad-alg')
  await seedRegisterChallenge(passkeys, 'register-challenge')
  const body = await registerMaterials(keyPair, 'register-challenge', credentialId, -7)

  const response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', { ...body, publicKeyAlgorithm: 5 }, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'unsupported_algorithm' })
})

test('register verify rejects a public key that cannot be imported', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('bad-key')
  await seedRegisterChallenge(passkeys, 'register-challenge')
  const body = await registerMaterials(keyPair, 'register-challenge', credentialId, -7)

  const response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', { ...body, publicKey: 'not-a-valid-spki' }, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_passkey' })
})

test('register verify rejects a duplicate credential id', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('duplicate')

  await seedRegisterChallenge(passkeys, 'challenge-a')
  const first = await registerMaterials(keyPair, 'challenge-a', credentialId, -7)
  const firstResponse = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', first, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(firstResponse.status, 201)

  await seedRegisterChallenge(passkeys, 'challenge-b')
  const second = await registerMaterials(keyPair, 'challenge-b', credentialId, -7)
  const secondResponse = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', second, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(secondResponse.status, 409)
  assert.deepEqual(await secondResponse.json(), { error: 'passkey_exists' })
})

test('register verify rejects an unknown, foreign, or expired challenge', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('challenge-checks')

  await seedRegisterChallenge(passkeys, 'foreign-challenge', 'other-user')
  let body = await registerMaterials(keyPair, 'foreign-challenge', credentialId, -7)
  let response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', body, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)

  await seedRegisterChallenge(passkeys, 'expired-challenge', userId, '2000-01-01T00:00:00.000Z')
  body = await registerMaterials(keyPair, 'expired-challenge', credentialId, -7)
  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', body, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)

  body = await registerMaterials(keyPair, 'missing-challenge', credentialId, -7)
  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', body, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)
})

test('register verify defaults and validates the name', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('name-default')
  await seedRegisterChallenge(passkeys, 'name-challenge')
  const base = await registerMaterials(keyPair, 'name-challenge', credentialId, -7)

  let response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', { ...base, name: '   ' }, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 201)
  assert.equal((await response.json() as { passkey: { name: string } }).passkey.name, 'Passkey')

  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', { ...base, name: 'a'.repeat(65) }, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)
})

test('register verify rejects bad rpIdHash, origin, type, missing UV, and crossOrigin', async () => {
  const keyPair = await generateEs256KeyPair()
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository()
  const handlers = makePasskeyHandlers(auth, passkeys)
  const credentialId = credentialIdBytes('protocol-rejections')
  await seedRegisterChallenge(passkeys, 'protocol-challenge')
  const base = await registerMaterials(keyPair, 'protocol-challenge', credentialId, -7)

  const badRp = { ...base, authenticatorData: await buildAuthenticatorData({ rpId: 'evil.test', flags: FLAG_REGISTER, signCount: 0, credentialId }) }
  let response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', badRp, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)

  const badOrigin = { ...base, clientDataJSON: buildClientDataJSON({ type: 'webauthn.create', challenge: 'protocol-challenge', origin: 'https://evil.test' }) }
  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', badOrigin, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)

  const badType = { ...base, clientDataJSON: buildClientDataJSON({ type: 'webauthn.get', challenge: 'protocol-challenge', origin }) }
  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', badType, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)

  const missingUv = { ...base, authenticatorData: await buildAuthenticatorData({ rpId, flags: 0x41, signCount: 0, credentialId }) }
  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', missingUv, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)

  const crossOrigin = { ...base, clientDataJSON: buildClientDataJSON({ type: 'webauthn.create', challenge: 'protocol-challenge', origin, crossOrigin: true }) }
  response = await handlers.registerVerify({ request: originRequest('/api/auth/passkey/register/verify', 'POST', crossOrigin, 'cloudhub_session=test-token'), env: verifyEnv() } as never)
  assert.equal(response.status, 400)
})

test('list returns passkey metadata without leaking key material', async () => {
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository({ credentials: [
    passkeyCredential({ id: 'credential-1', name: 'Phone', public_key: 'SECRET_PUBLIC', prf_wrapped_master_key: 'SECRET_WRAPPED', created_at: '2030-01-02T00:00:00.000Z' }),
    passkeyCredential({ id: 'credential-2', name: 'Laptop', created_at: '2030-01-01T00:00:00.000Z' }),
  ] })
  const handler = createListPasskeysHandler({ createAuthRepository: () => auth.repository, createPasskeyRepository: () => passkeys.repository })

  const response = await call(handler, 'GET', '/api/auth/passkey', undefined, 'cloudhub_session=test-token')
  assert.equal(response.status, 200)
  const body = await response.json() as { passkeys: Array<Record<string, unknown>> }
  assert.equal(body.passkeys.length, 2)
  assert.deepEqual(body.passkeys[0], { id: 'credential-2', name: 'Laptop', createdAt: '2030-01-01T00:00:00.000Z', lastUsedAt: null, prf: false })
  assert.deepEqual(body.passkeys[1], { id: 'credential-1', name: 'Phone', createdAt: '2030-01-02T00:00:00.000Z', lastUsedAt: null, prf: true })
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes('SECRET_PUBLIC'), false)
  assert.equal(serialized.includes('SECRET_WRAPPED'), false)
})

test('rename and delete enforce ownership', async () => {
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository({ credentials: [
    passkeyCredential({ id: 'own-credential', name: 'Own' }),
    passkeyCredential({ id: 'other-credential', name: 'Other', user_id: 'other-user' }),
  ] })
  const handler = createPasskeyIdHandler({ createAuthRepository: () => auth.repository, createPasskeyRepository: () => passkeys.repository })

  let response = await call(handler, 'PATCH', '/api/auth/passkey/own-credential', { name: 'Renamed' }, 'cloudhub_session=test-token', { id: 'own-credential' })
  assert.equal(response.status, 200)
  assert.deepEqual(passkeys.renamed, [['own-credential', 'Renamed']])

  response = await call(handler, 'PATCH', '/api/auth/passkey/other-credential', { name: 'Nope' }, 'cloudhub_session=test-token', { id: 'other-credential' })
  assert.equal(response.status, 404)

  response = await call(handler, 'DELETE', '/api/auth/passkey/own-credential', undefined, 'cloudhub_session=test-token', { id: 'own-credential' })
  assert.equal(response.status, 204)
  assert.deepEqual(passkeys.deletedPasskeys, ['own-credential'])

  response = await call(handler, 'DELETE', '/api/auth/passkey/other-credential', undefined, 'cloudhub_session=test-token', { id: 'other-credential' })
  assert.equal(response.status, 404)
})

test('prf can be set once and then returns 409', async () => {
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const passkeys = passkeyRepository({ credentials: [passkeyCredential({ id: 'own-credential' })] })
  const handler = createPasskeyPrfHandler({ createAuthRepository: () => auth.repository, createPasskeyRepository: () => passkeys.repository })

  let response = await call(handler, 'POST', '/api/auth/passkey/own-credential/prf', { prfWrappedMasterKey: prfWrappedKey }, 'cloudhub_session=test-token', { id: 'own-credential' })
  assert.equal(response.status, 204)
  assert.deepEqual(passkeys.prfSet, [['own-credential', prfWrappedKey]])

  response = await call(handler, 'POST', '/api/auth/passkey/own-credential/prf', { prfWrappedMasterKey: prfWrappedKey }, 'cloudhub_session=test-token', { id: 'own-credential' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'prf_already_set' })
})
