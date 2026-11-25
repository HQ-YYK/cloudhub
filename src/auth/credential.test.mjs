import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialFor } from './credential.ts'
import { deriveFromPassword, generateKdfSalt } from '../crypto/index.ts'

test('credentialFor derives authKey and wrapKey', async () => {
  const salt = generateKdfSalt()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ kdfSalt: salt, kdfIterations: 1000 }),
    { headers: { 'Content-Type': 'application/json' } },
  )
  try {
    const credential = await credentialFor('alice', 'correct-horse')
    const expected = await deriveFromPassword('correct-horse', salt, 1000)
    assert.equal(credential.authKey, expected.authKey)
    assert.ok('wrapKey' in credential)
    assert.ok(credential.wrapKey)
  } finally {
    globalThis.fetch = originalFetch
  }
})
