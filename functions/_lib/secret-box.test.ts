import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decryptSecret, encryptSecret } from './secret-box.ts'

test('secret box encrypts and decrypts secrets and uses a fresh IV', async () => {
  const key = Buffer.from('1'.repeat(32), 'ascii').toString('base64url')
  const first = await encryptSecret('refresh-secret', key)
  const second = await encryptSecret('refresh-secret', key)
  assert.equal(await decryptSecret(first.ciphertext, first.iv, key), 'refresh-secret')
  assert.equal(await decryptSecret(second.ciphertext, second.iv, key), 'refresh-secret')
  assert.notEqual(first.iv, second.iv)
})

test('secret box rejects invalid key lengths', async () => {
  await assert.rejects(
    encryptSecret('secret', Buffer.from('short').toString('base64url')),
    /storage_key_invalid/u,
  )
})
