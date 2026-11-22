import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthRequestError, changePassword } from './auth.ts'

test('changePassword sends POST and reports backend error codes', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (input, init) => {
    request = { input, init }
    return new Response(JSON.stringify({ error: 'weak_password' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await assert.rejects(
      changePassword('old-password', 'new-password'),
      (error) => error instanceof AuthRequestError
        && error.status === 400
        && error.code === 'weak_password',
    )
    assert.equal(request.input, '/api/auth/password')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.init.body), {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
