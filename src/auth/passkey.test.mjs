import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base64UrlEncode, CryptoError } from '../crypto/index.ts'
import {
  prfSalt,
  prfWrapKey,
  toPublicKeyCredentialCreationOptions,
  toPublicKeyCredentialRequestOptions,
  unwrapMasterKeyWithPrf,
  wrapMasterKeyWithPrf,
} from './passkey.ts'

function isCode(code) {
  return (error) => error instanceof CryptoError && error.code === code
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length))
}

test('prfSalt is the SHA-256 of the fixed input', async () => {
  const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cloudhub/v1/prf-salt'))
  assert.deepEqual(await prfSalt(), new Uint8Array(expected))
})

test('prfWrapKey derives a non-exportable AES-GCM key', async () => {
  const key = await prfWrapKey(randomBytes(32))
  assert.equal(key.extractable, false)
  assert.equal(key.algorithm.name, 'AES-GCM')
  assert.ok(key.usages.includes('encrypt'))
  assert.ok(key.usages.includes('decrypt'))
})

test('wrapMasterKeyWithPrf round-trips through unwrapMasterKeyWithPrf', async () => {
  const mk = randomBytes(32)
  const prfOutput = randomBytes(32)

  const wrapped = await wrapMasterKeyWithPrf(mk, prfOutput, 'user-1', 'cred-1')
  assert.deepEqual(await unwrapMasterKeyWithPrf(wrapped, prfOutput, 'user-1', 'cred-1'), mk)
})

test('unwrapMasterKeyWithPrf fails for a different userId or credentialId', async () => {
  const mk = randomBytes(32)
  const prfOutput = randomBytes(32)

  const wrapped = await wrapMasterKeyWithPrf(mk, prfOutput, 'user-1', 'cred-1')
  await assert.rejects(unwrapMasterKeyWithPrf(wrapped, prfOutput, 'user-2', 'cred-1'), isCode('decrypt_failed'))
  await assert.rejects(unwrapMasterKeyWithPrf(wrapped, prfOutput, 'user-1', 'cred-2'), isCode('decrypt_failed'))
})

test('unwrapMasterKeyWithPrf fails for a different PRF output', async () => {
  const mk = randomBytes(32)
  const prfOutput = randomBytes(32)
  const otherPrf = randomBytes(32)

  const wrapped = await wrapMasterKeyWithPrf(mk, prfOutput, 'user-1', 'cred-1')
  await assert.rejects(unwrapMasterKeyWithPrf(wrapped, otherPrf, 'user-1', 'cred-1'), isCode('decrypt_failed'))
})

test('unwrapMasterKeyWithPrf fails when the unwrapped key is not 32 bytes', async () => {
  const prfOutput = randomBytes(32)

  const wrapped = await wrapMasterKeyWithPrf(randomBytes(16), prfOutput, 'user-1', 'cred-1')
  await assert.rejects(unwrapMasterKeyWithPrf(wrapped, prfOutput, 'user-1', 'cred-1'), isCode('decrypt_failed'))
})

test('toPublicKeyCredentialCreationOptions decodes challenge, user.id and excludeCredentials ids', async () => {
  const salt = await prfSalt()
  const options = {
    challenge: base64UrlEncode(new Uint8Array([1, 2, 3, 4])),
    rp: { id: 'localhost', name: 'CloudHub' },
    user: { id: base64UrlEncode(new Uint8Array([9, 8, 7])), name: 'alice', displayName: 'alice' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: [
      { type: 'public-key', id: base64UrlEncode(new Uint8Array([5, 6])), transports: ['internal'] },
      { type: 'public-key', id: base64UrlEncode(new Uint8Array([7])), transports: undefined },
    ],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
    timeout: 300000,
  }

  const result = toPublicKeyCredentialCreationOptions(options, salt)

  assert.deepEqual(Array.from(result.challenge), [1, 2, 3, 4])
  assert.deepEqual(Array.from(result.user.id), [9, 8, 7])
  assert.deepEqual(Array.from(result.excludeCredentials[0].id), [5, 6])
  assert.deepEqual(result.excludeCredentials[0].transports, ['internal'])
  assert.equal(result.excludeCredentials[1].transports, undefined)
  assert.deepEqual(result.extensions.prf.eval.first, salt)
})

test('toPublicKeyCredentialRequestOptions decodes the challenge and keeps allowCredentials empty', async () => {
  const salt = await prfSalt()
  const options = {
    challenge: base64UrlEncode(new Uint8Array([7, 8])),
    rpId: 'localhost',
    userVerification: 'required',
    timeout: 300000,
  }

  const result = toPublicKeyCredentialRequestOptions(options, salt)

  assert.deepEqual(Array.from(result.challenge), [7, 8])
  assert.equal(result.rpId, 'localhost')
  assert.deepEqual(result.allowCredentials, [])
  assert.deepEqual(result.extensions.prf.eval.first, salt)
})
