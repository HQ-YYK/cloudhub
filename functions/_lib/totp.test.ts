import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  otpauthUrl,
  TOTP_DIGITS,
  totpCode,
  verifyTotpCode,
} from './totp.ts'

test('base32 encodes and decodes 20 random bytes without padding', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  const encoded = base32Encode(bytes)
  assert.match(encoded, /^[A-Z2-7]+$/u)
  assert.doesNotMatch(encoded, /=/u)
  assert.deepEqual(base32Decode(encoded), bytes)
})

test('generated TOTP secrets are 32 unpadded base32 characters (20 bytes)', () => {
  const secret = generateTotpSecret()
  assert.match(secret, /^[A-Z2-7]{32}$/u)
  assert.equal(base32Decode(secret).byteLength, 20)
})

test('totpCode matches the RFC 6238 Appendix B SHA-1 vectors via the last 6 digits', async () => {
  const secret = new TextEncoder().encode('12345678901234567890')
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [time, expected] of vectors) {
    const code = await totpCode(secret, Math.floor(time / 30), 8)
    assert.equal(code.slice(-6), expected.slice(-6))
  }
})

test('verifyTotpCode accepts the current and adjacent time steps', async () => {
  const secret = generateTotpSecret()
  const nowMs = 1_700_000_000_000
  const currentStep = Math.floor(nowMs / 1000 / 30)
  const currentCode = await totpCode(base32Decode(secret), currentStep, TOTP_DIGITS)
  const previousCode = await totpCode(base32Decode(secret), currentStep - 1, TOTP_DIGITS)
  const nextCode = await totpCode(base32Decode(secret), currentStep + 1, TOTP_DIGITS)

  assert.equal(await verifyTotpCode(secret, currentCode, null, nowMs), currentStep)
  assert.equal(await verifyTotpCode(secret, previousCode, null, nowMs), currentStep - 1)
  assert.equal(await verifyTotpCode(secret, nextCode, null, nowMs), currentStep + 1)
})

test('verifyTotpCode rejects codes outside the window and replays of a used step', async () => {
  const secret = generateTotpSecret()
  const nowMs = 1_700_000_000_000
  const currentStep = Math.floor(nowMs / 1000 / 30)
  const currentCode = await totpCode(base32Decode(secret), currentStep, TOTP_DIGITS)
  const previousCode = await totpCode(base32Decode(secret), currentStep - 1, TOTP_DIGITS)
  const staleCode = await totpCode(base32Decode(secret), currentStep - 2, TOTP_DIGITS)

  assert.equal(await verifyTotpCode(secret, staleCode, null, nowMs), null)
  // After currentStep is recorded, an earlier step must not be accepted again.
  assert.equal(await verifyTotpCode(secret, previousCode, currentStep, nowMs), null)
  assert.equal(await verifyTotpCode(secret, currentCode, currentStep, nowMs), null)
})

test('otpauthUrl encodes the label and every parameter', () => {
  const url = otpauthUrl('alice', 'SECRET123')
  const [scheme, query] = url.split('?')
  assert.equal(scheme, 'otpauth://totp/CloudHub%3Aalice')
  const params = new URLSearchParams(query)
  assert.equal(params.get('secret'), 'SECRET123')
  assert.equal(params.get('issuer'), 'CloudHub')
  assert.equal(params.get('algorithm'), 'SHA1')
  assert.equal(params.get('digits'), '6')
  assert.equal(params.get('period'), '30')
})

test('recovery codes use the xxxx-xxxx lowercase letter and digit format', () => {
  for (let index = 0; index < 20; index += 1) {
    assert.match(generateRecoveryCode(), /^[a-z0-9]{4}-[a-z0-9]{4}$/u)
  }
})
