import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository, StoredUser } from '../../_lib/auth-repository.ts'
import { hashPassword } from '../../_lib/auth.ts'
import { createPasswordHandler } from './password.ts'

function repository(stored: StoredUser) {
  let passwordUpdates = 0
  let revokedKeep = ''
  let loginFailures = 0
  const authRepository: AuthRepository = {
    findUser: async (username) => username === stored.username ? stored : null,
    findSessionUser: async () => ({
      session_id: 'current-session',
      id: stored.id,
      username: stored.username,
      role: stored.role,
      must_change_password: stored.must_change_password,
    }),
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => { loginFailures += 1 },
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async (_id, _hash, _salt, _iterations, mustChangePassword) => {
      passwordUpdates += 1
      stored.must_change_password = mustChangePassword
    },
    setDisabled: async () => undefined,
    revokeOtherSessions: async (_id, keepSessionId) => { revokedKeep = keepSessionId },
  }
  return {
    authRepository,
    get passwordUpdates() { return passwordUpdates },
    get revokedKeep() { return revokedKeep },
    get loginFailures() { return loginFailures },
  }
}

test('password change validates weak passwords and current password failures', async () => {
  const initial = await hashPassword('current-password')
  const stored: StoredUser = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    password_hash: initial.hash,
    password_salt: initial.salt,
    password_iterations: initial.iterations,
    disabled: 0,
    role: 'user',
    must_change_password: 1,
  }
  const current = repository(stored)
  const handler = createPasswordHandler({ createAuthRepository: () => current.authRepository })
  const env = { DB: {} as D1Database }

  let response = await handler({
    request: new Request('https://cloudhub.test/api/auth/password', {
      method: 'POST',
      headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json', Cookie: 'cloudhub_session=token' },
      body: JSON.stringify({ currentPassword: 'current-password', newPassword: 'short' }),
    }),
    env,
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'weak_password' })

  response = await handler({
    request: new Request('https://cloudhub.test/api/auth/password', {
      method: 'POST',
      headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json', Cookie: 'cloudhub_session=token' },
      body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'new-password-123' }),
    }),
    env,
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(current.loginFailures, 1)

  response = await handler({
    request: new Request('https://cloudhub.test/api/auth/password', {
      method: 'POST',
      headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json', Cookie: 'cloudhub_session=token' },
      body: JSON.stringify({ currentPassword: 'current-password', newPassword: 'new-password-123' }),
    }),
    env,
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(stored.must_change_password, 0)
  assert.equal(current.passwordUpdates, 1)
  assert.equal(current.revokedKeep, 'current-session')
})
