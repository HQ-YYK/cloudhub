import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { sha256 } from '../../_lib/auth.ts'
import { base32Decode, TOTP_DIGITS, totpCode } from '../../_lib/totp.ts'
import { createLoginHandler } from './login.ts'
import { createVerifyTotpHandler } from './totp/verify.ts'
import {
  authKey,
  authRepository,
  enabledUser,
  originRequest,
  plainUser,
  storedUser,
  totpRepository,
  userId,
  verifyEnv,
} from './totp.fixtures.ts'

test('login returns a challenge instead of a session when TOTP is enabled', async () => {
  const stored = await storedUser(authKey)
  const { user } = await enabledUser()
  const auth = authRepository({ stored })
  const totp = totpRepository(user)
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/login', 'POST', { username: 'alice', authKey }),
    env: { DB: {} as D1Database },
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { totpRequired: boolean, challenge: string }
  assert.equal(body.totpRequired, true)
  assert.match(body.challenge, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(response.headers.get('Set-Cookie'), null)

  const created = totp.createdChallenges[0]
  assert.equal(created.userId, userId)
  assert.equal(created.tokenHash, await sha256(body.challenge))
  assert.equal(auth.sessions.length, 0)
})

test('login still issues a session when TOTP is not enabled', async () => {
  const stored = await storedUser(authKey)
  const auth = authRepository({ stored })
  const totp = totpRepository(plainUser())
  const handler = createLoginHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/login', 'POST', { username: 'alice', authKey }),
    env: { DB: {} as D1Database },
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { user: { username: string } }
  assert.equal(body.user.username, 'alice')
  assert.match(response.headers.get('Set-Cookie') ?? '', /^cloudhub_session=/)
  assert.equal(auth.sessions.length, 1)
})

test('verify accepts a valid code, deletes the challenge, and issues a session', async () => {
  const { secret, user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const challenge = 'A'.repeat(43)
  const tokenHash = await sha256(challenge)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash,
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const step = Math.floor(Date.now() / 1000 / 30)
  const code = await totpCode(base32Decode(secret), step, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, code }),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { user: Record<string, unknown> }
  assert.deepEqual(body.user, { id: userId, username: 'alice', role: 'user', mustChangePassword: false, keysReady: false })
  assert.match(response.headers.get('Set-Cookie') ?? '', /^cloudhub_session=/)
  assert.ok(totp.deletedChallenges.includes(tokenHash))
  assert.equal(auth.sessions.length, 1)
  assert.equal(totp.lastSteps.length, 1)
})

test('verify rejects a wrong code, increments the failure count, and records a login failure', async () => {
  const { secret, user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const challenge = 'B'.repeat(43)
  const tokenHash = await sha256(challenge)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash,
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, code: stale }),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.deepEqual(totp.incrementedChallenges, [tokenHash])
  assert.equal(totp.deletedChallenges.length, 0)
  assert.equal(auth.loginFailures.length, 1)
  assert.deepEqual(auth.loginFailures[0], ['alice', 'ip-hash'])
})

test('verify deletes the challenge after the fifth failed attempt', async () => {
  const { secret, user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const challenge = 'C'.repeat(43)
  const tokenHash = await sha256(challenge)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash,
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  totp.challenges.get(tokenHash)!.failed_count = 4
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  const stale = await totpCode(base32Decode(secret), 1, TOTP_DIGITS)
  const response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, code: stale }),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
  assert.deepEqual(totp.deletedChallenges, [tokenHash])
  assert.equal(totp.incrementedChallenges.length, 0)
  assert.equal(auth.loginFailures.length, 1)
})

test('verify rejects an expired or unknown challenge with 401', async () => {
  const { user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const expired = 'D'.repeat(43)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash: await sha256(expired),
    ipHash: 'ip-hash',
    createdAt: '2000-01-01T00:00:00.000Z',
    expiresAt: '2000-01-01T00:05:00.000Z',
  })
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  let response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge: expired, code: '123456' }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })

  response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge: 'E'.repeat(43), code: '123456' }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })

  assert.equal(auth.loginFailures.length, 0)
  assert.equal(totp.incrementedChallenges.length, 0)
  assert.equal(totp.deletedChallenges.length, 0)
})

test('verify accepts a recovery code once and rejects reuse', async () => {
  const { user } = await enabledUser()
  const auth = authRepository()
  const totp = totpRepository(user)
  const recoveryCode = 'abcd-efgh'
  await totp.repository.createRecoveryCodes([{
    id: 'recovery-1',
    userId,
    codeHash: await sha256(recoveryCode),
    createdAt: '2030-01-01T00:00:00.000Z',
  }])
  const handler = createVerifyTotpHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
  })

  let challenge = 'F'.repeat(43)
  await totp.repository.createLoginChallenge({
    id: 'challenge-1',
    userId,
    tokenHash: await sha256(challenge),
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  let response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, recoveryCode }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(totp.markedUsed, ['recovery-1'])
  assert.equal(auth.sessions.length, 1)

  challenge = 'G'.repeat(43)
  await totp.repository.createLoginChallenge({
    id: 'challenge-2',
    userId,
    tokenHash: await sha256(challenge),
    ipHash: 'ip-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  response = await handler({
    request: originRequest('/api/auth/totp/verify', 'POST', { challenge, recoveryCode }),
    env: verifyEnv(),
  } as never)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_code' })
})
