import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authRepository,
  originRequest,
  passkeyCredential,
  passkeyRepository,
  passkeySessionUser,
  verifyEnv,
} from './passkey.fixtures.ts'
import { plainUser, totpRepository } from './totp.fixtures.ts'
import { createMeHandler } from './me.ts'

test('me returns the passkey count', async () => {
  const auth = authRepository({ sessionUser: passkeySessionUser })
  const totp = totpRepository(plainUser())
  const passkeys = passkeyRepository({ credentials: [
    passkeyCredential({ id: 'passkey-a', created_at: '2030-01-01T00:00:00.000Z' }),
    passkeyCredential({ id: 'passkey-b', created_at: '2030-01-02T00:00:00.000Z' }),
  ] })
  const handler = createMeHandler({
    createAuthRepository: () => auth.repository,
    createTotpRepository: () => totp.repository,
    createPasskeyRepository: () => passkeys.repository,
  })

  const response = await handler({
    request: originRequest('/api/auth/me', 'GET', undefined, 'cloudhub_session=test-token'),
    env: verifyEnv(),
  } as never)

  assert.equal(response.status, 200)
  const body = await response.json() as { user: { passkeyCount: number, totpEnabled: boolean } }
  assert.equal(body.user.passkeyCount, 2)
  assert.equal(body.user.totpEnabled, false)
})
