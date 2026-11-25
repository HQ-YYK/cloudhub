import type { PagesFunction } from '@cloudflare/workers-types'
import {
  clearLoginFailures,
  createSession,
  createSessionToken,
  getLoginAttempt,
  hashSessionToken,
  isLoginBlocked,
  recordLoginFailure,
  sessionCookie,
  sha256,
} from '../../../_lib/auth.ts'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1TotpRepository } from '../../../_lib/d1-totp-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { decryptSecret } from '../../../_lib/secret-box.ts'
import { MAX_CHALLENGE_FAILURES, verifyTotpCode } from '../../../_lib/totp.ts'
import type { TotpRepository } from '../../../_lib/totp-repository.ts'

const INVALID_CODE = { error: 'invalid_code' }
const MAX_BODY_LENGTH = 2048

interface VerifyTotpDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTotpRepository: (env: AuthEnv) => TotpRepository
}

export function createVerifyTotpHandler(
  overrides: Partial<VerifyTotpDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: VerifyTotpDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createTotpRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1TotpRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
    const encryptionKey = context.env.STORAGE_ENCRYPTION_KEY
    if (!encryptionKey) return jsonResponse({ error: 'service_unavailable' }, 503)

    let payload: { challenge?: unknown; code?: unknown; recoveryCode?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    const hasCode = typeof payload.code === 'string'
    const hasRecoveryCode = typeof payload.recoveryCode === 'string'
    if (typeof payload.challenge !== 'string' || hasCode === hasRecoveryCode) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const totpRepository = dependencies.createTotpRepository(context.env)
      const now = new Date()
      const tokenHash = await sha256(payload.challenge)
      const challenge = await totpRepository.findLoginChallengeByTokenHash(tokenHash, now.toISOString())
      if (!challenge) return jsonResponse(INVALID_CODE, 401)

      const user = await totpRepository.findTotpUser(challenge.user_id)
      if (!user || user.disabled !== 0 || !user.totp_secret_ciphertext || !user.totp_secret_iv) {
        return jsonResponse(INVALID_CODE, 401)
      }

      const attempt = await getLoginAttempt(authRepository, user.username, challenge.ip_hash)
      if (isLoginBlocked(attempt, now)) return jsonResponse(INVALID_CODE, 401)

      let verified = false
      if (hasCode) {
        let secret: string
        try {
          secret = await decryptSecret(user.totp_secret_ciphertext, user.totp_secret_iv, encryptionKey)
        } catch {
          return jsonResponse({ error: 'service_unavailable' }, 503)
        }
        const step = await verifyTotpCode(secret, payload.code as string, user.totp_last_step, now.getTime())
        if (step !== null && await totpRepository.updateLastStep(user.id, step)) {
          verified = true
        }
      } else {
        const codeHash = await sha256(payload.recoveryCode as string)
        const recovery = await totpRepository.findRecoveryCode(user.id, codeHash)
        if (
          recovery &&
          recovery.used_at === null &&
          await totpRepository.markRecoveryCodeUsed(recovery.id, now.toISOString())
        ) {
          verified = true
        }
      }

      if (!verified) {
        if (challenge.failed_count + 1 >= MAX_CHALLENGE_FAILURES) {
          await totpRepository.deleteLoginChallengeByTokenHash(tokenHash)
        } else {
          await totpRepository.incrementLoginChallengeFailure(tokenHash)
        }
        await recordLoginFailure(authRepository, user.username, challenge.ip_hash, now)
        return jsonResponse(INVALID_CODE, 401)
      }

      // Consuming the challenge must succeed exactly once; a concurrent winner already used it.
      const consumed = await totpRepository.deleteLoginChallengeByTokenHash(tokenHash)
      if (!consumed) return jsonResponse(INVALID_CODE, 401)

      const token = createSessionToken()
      const sessionTokenHash = await hashSessionToken(token)
      const timestamp = now.toISOString()
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

      await createSession(authRepository, {
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: sessionTokenHash,
        createdAt: timestamp,
        expiresAt,
        lastSeenAt: timestamp,
      })
      await clearLoginFailures(authRepository, user.username, challenge.ip_hash)

      return jsonResponse({ user: {
        id: user.id,
        username: user.username,
        role: user.role,
        mustChangePassword: user.must_change_password === 1,
      } }, 200, {
        'Set-Cookie': sessionCookie(token),
      })
    } catch (error) {
      console.error('TOTP verify request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createVerifyTotpHandler()
