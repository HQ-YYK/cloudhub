import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialFor } from './credential.ts'
import { deriveFromPassword, generateKdfSalt } from '../crypto/index.ts'

test('credentialFor returns the raw password for a legacy account', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/auth/prelogin')
    assert.deepEqual(JSON.parse(init.body), { username: 'alice' })
    return new Response(JSON.stringify({ legacy: true }), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    assert.deepEqual(await credentialFor('alice', 'correct-horse'), { password: 'correct-horse' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('credentialFor derives authKey and wrapKey for a new-format account', async () => {
  const salt = generateKdfSalt()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ legacy: false, kdfSalt: salt, kdfIterations: 1000 }),
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
