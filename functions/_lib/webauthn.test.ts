import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rawToDerSignature } from '../api/auth/passkey.fixtures.ts'
import { derToRawSignature } from './webauthn.ts'

test('DER conversion keeps a 33-byte integer with a leading zero sign byte', () => {
  const raw = new Uint8Array(64)
  raw[0] = 0xff
  raw[31] = 0x01
  raw[32] = 0x7f
  raw[63] = 0x02
  const der = rawToDerSignature(raw)
  assert.deepEqual(derToRawSignature(der), raw)
})

test('DER conversion left-pads small integers that had leading zero bytes', () => {
  const raw = new Uint8Array(64)
  raw[31] = 0x01
  raw[63] = 0x02
  const der = rawToDerSignature(raw)
  assert.deepEqual(derToRawSignature(der), raw)
})

test('DER conversion rejects malformed input instead of throwing', () => {
  assert.equal(derToRawSignature(new Uint8Array([0x30, 0x02])), null)
  assert.equal(derToRawSignature(new Uint8Array(64)), null)
})
