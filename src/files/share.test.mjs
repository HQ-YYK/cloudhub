import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportFileKey } from '../crypto/index.ts'
import { buildShareUrl, parseShareKeyHash, shareUrlWithKey } from './share.ts'

test('buildShareUrl joins origin, token, and the exported key', () => {
  const fk = new Uint8Array(32).fill(7)
  const url = buildShareUrl('https://cloudhub.test', 'tok123', fk)
  assert.equal(url, `https://cloudhub.test/s/tok123#k=${exportFileKey(fk)}`)
})

test('shareUrlWithKey appends the key to an existing base URL', () => {
  const fk = new Uint8Array(32).fill(9)
  assert.equal(shareUrlWithKey('https://cloudhub.test/s/tok123', fk), `https://cloudhub.test/s/tok123#k=${exportFileKey(fk)}`)
})

test('parseShareKeyHash round-trips an exported key', () => {
  const fk = new Uint8Array(32).fill(3)
  assert.deepEqual([...parseShareKeyHash(`#k=${exportFileKey(fk)}`)], [...fk])
})

test('parseShareKeyHash returns null for a missing or malformed fragment', () => {
  assert.equal(parseShareKeyHash(''), null)
  assert.equal(parseShareKeyHash('#other=1'), null)
  assert.equal(parseShareKeyHash('#k=not-32-bytes'), null)
})
