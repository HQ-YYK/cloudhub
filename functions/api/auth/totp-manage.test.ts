import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../../_lib/auth.ts'
import { base32Decode, otpauthUrl, TOTP_DIGITS, totpCode } from '../../_lib/totp.ts'
import { createAdminTotpResetHandler } from '../admin/users/[id]/totp/reset.ts'
import { createTotpDisableHandler } from './totp/disable.ts'
import { createTotpEnableHandler } from './totp/enable.ts'
import { createTotpSetupHandler } from './totp/setup.ts'
import {
  adminId,
  adminSessionUser,
  adminTarget,
  authKey,
  authRepository,
  enabledUser,
  originRequest,
  pendingUser,
  plainUser,
  sessionUser,
  storedUser,
  totpRepository,
  userId,
  verifyEnv,
  wrongAuthKey,
} from './totp.fixtures.ts'

test('setup generates a pending secret and an otpauth URL', async () => {
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(plainUser())
  const handler = createTotpSetupHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/totp/setup', 'POST', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { secret: string, otpauthUrl: string }
  assert.match(body.secret, /^[A-Z2-7]{32}$/u)
  assert.equal(body.otpauthUrl, otpauthUrl('alice', body.secret))
  assert.ok(totp.user!.totp_pending_ciphertext)
  assert.ok(totp.user!.totp_pending_iv)
  assert.equal(totp.user!.totp_secret_ciphertext, null)
})

test('setup returns 409 when TOTP is already enabled', async () => {
  const { user } = await enabledUser()
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpSetupHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/totp/setup', 'POST', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'totp_already_enabled' })
})

test('enable promotes the pending secret and returns one-time recovery codes', async () => {
  const { secret, user } = await pendingUser()
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpEnableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const step = Math.floor(Date.now() / 1000 / 30)
  const code = await totpCode(base32Decode(secret), step, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/enable', 'POST', { code }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { recoveryCodes: string[] }
  assert.equal(body.recoveryCodes.length, 10)
  for (const recoveryCode of body.recoveryCodes) {
    assert.match(recoveryCode, /^[a-z0-9]{4}-[a-z0-9]{4}$/u)
  }
  assert.ok(totp.user!.totp_secret_ciphertext)
  assert.equal(totp.user!.totp_pending_ciphertext, null)
  assert.ok(totp.user!.totp_enabled_at)
  assert.equal(totp.recoveryCodes.length, 10)
  for (const recoveryCode of body.recoveryCodes) {
    const codeHash = await sha256(recoveryCode)
    assert.ok(totp.recoveryCodes.some((stored) => stored.code_hash === codeHash))
  }
})

test('enable rejects a wrong code without enabling TOTP', async () => {
  const { secret, user } = await pendingUser()
  const auth = authRepository({ sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpEnableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/enable', 'POST', { code: stale }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.equal(totp.user!.totp_secret_ciphertext, null)
  assert.equal(totp.recoveryCodes.length, 0)
})

test('disable requires the auth key and a valid code, then clears TOTP and recovery codes', async () => {
  const { secret, user } = await enabledUser()
  const stored = await storedUser(authKey)
  const auth = authRepository({ stored, sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpDisableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const step = Math.floor(Date.now() / 1000 / 30)
  const code = await totpCode(base32Decode(secret), step, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/disable', 'POST', { authKey, code }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(totp.user!.totp_secret_ciphertext, null)
  assert.deepEqual(totp.deletedRecoveryUsers, [userId])
})

test('disable rejects a wrong auth key and records a login failure', async () => {
  const { user } = await enabledUser()
  const stored = await storedUser(authKey)
  const auth = authRepository({ stored, sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpDisableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/totp/disable', 'POST', { authKey: wrongAuthKey, code: '123456' }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.equal(auth.loginFailures.length, 1)
})

test('disable rejects a wrong code after a correct auth key', async () => {
  const { secret, user } = await enabledUser()
  const stored = await storedUser(authKey)
  const auth = authRepository({ stored, sessionUser })
  const totp = totpRepository(user)
  const handler = createTotpDisableHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/disable', 'POST', { authKey, code: stale }, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.ok(totp.user!.totp_secret_ciphertext)
})

test('admin reset clears TOTP, recovery codes, and sessions for another user', async () => {
  const { user } = await enabledUser()
  const auth = authRepository({ sessionUser: adminSessionUser, users: [adminTarget('user')] })
  const totp = totpRepository(user)
  const handler = createAdminTotpResetHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest(`/api/admin/users/${userId}/totp/reset`, 'POST', undefined, 'cloudhub_session=admin-token'),
    env: verifyEnv(),
    params: { id: userId },
  } as never)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(totp.disabledUsers, [userId])
  assert.deepEqual(totp.deletedRecoveryUsers, [userId])
  assert.deepEqual(auth.revokedAll, [userId])
})

test('admin reset rejects resetting yourself', async () => {
  const auth = authRepository({ sessionUser: adminSessionUser, users: [adminTarget('admin')] })
  const totp = totpRepository(null)
  const handler = createAdminTotpResetHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest(`/api/admin/users/${adminId}/totp/reset`, 'POST', undefined, 'cloudhub_session=admin-token'),
    env: verifyEnv(),
    params: { id: adminId },
  } as never)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })
})

test('TOTP management requires an authenticated user', async () => {
  const auth = authRepository({ sessionUser: null })
  const totp = totpRepository(null)
  const setup = createTotpSetupHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })
  const enable = createTotpEnableHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })
  const disable = createTotpDisableHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })
  const reset = createAdminTotpResetHandler({ createAuthRepository: () => auth.repository, createTotpRepository: () => totp.repository })

  assert.equal((await setup({ request: originRequest('/api/auth/totp/setup', 'POST'), env: verifyEnv() } as never)).status, 401)
  assert.equal((await enable({ request: originRequest('/api/auth/totp/enable', 'POST', { code: '123456' }), env: verifyEnv() } as never)).status, 401)
  assert.equal((await disable({ request: originRequest('/api/auth/totp/disable', 'POST', { authKey, code: '123456' }), env: verifyEnv() } as never)).status, 401)
  assert.equal((await reset({ request: originRequest(`/api/admin/users/${userId}/totp/reset`, 'POST'), env: verifyEnv(), params: { id: userId } } as never)).status, 401)
})

test('admin reset requires an admin role', async () => {
  const auth = authRepository({ sessionUser, users: [adminTarget('user')] })
  const totp = totpRepository(null)
  const handler = createAdminTotpResetHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest(`/api/admin/users/${userId}/totp/reset`, 'POST', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
    params: { id: userId },
  } as never)

  assert.equal(response.status, 403)
})
