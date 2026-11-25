import type { PagesFunction } from '@cloudflare/workers-types'
import {
  getAuthenticatedUser,
  getLoginAttempt,
  isLoginBlocked,
  recordLoginFailure,
  sha256,
  verifyPassword,
} from '../../../_lib/auth.ts'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1TotpRepository } from '../../../_lib/d1-totp-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { isValidAuthKey } from '../../../_lib/keys.ts'
import { decryptSecret } from '../../../_lib/secret-box.ts'
import { verifyTotpCode } from '../../../_lib/totp.ts'
import type { TotpRepository } from '../../../_lib/totp-repository.ts'

const MAX_BODY_LENGTH = 2048

interface TotpDisableDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTotpRepository: (env: AuthEnv) => TotpRepository
}

export function createTotpDisableHandler(
  overrides: Partial<TotpDisableDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: TotpDisableDependencies = {
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

    let payload: { authKey?: unknown; code?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (typeof payload.code !== 'string' || !isValidAuthKey(payload.authKey)) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }
    const authKey = payload.authKey
    const code = payload.code

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const totpRepository = dependencies.createTotpRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const stored = await authRepository.findUser(user.username)
      if (!stored) return jsonResponse({ error: 'invalid_credentials' }, 401)

      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const ipHash = await sha256(ip)
      const now = new Date()
      const attempt = await getLoginAttempt(authRepository, user.username, ipHash)
      if (isLoginBlocked(attempt, now)) return jsonResponse({ error: 'invalid_credentials' }, 401)

      const credentialMatches = await verifyPassword(
        authKey,
        stored.password_hash,
        stored.password_salt,
        stored.password_iterations,
      )

      if (!credentialMatches) {
        await recordLoginFailure(authRepository, user.username, ipHash, now)
        return jsonResponse({ error: 'invalid_credentials' }, 401)
      }

      const totpUser = await totpRepository.findTotpUser(user.id)
      if (!totpUser) return jsonResponse({ error: 'service_unavailable' }, 503)

      let verified = false
      const recovery = await totpRepository.findRecoveryCode(user.id, await sha256(code))
      if (
        recovery &&
        recovery.used_at === null &&
        await totpRepository.markRecoveryCodeUsed(recovery.id, now.toISOString())
      ) {
        verified = true
      } else if (totpUser.totp_secret_ciphertext && totpUser.totp_secret_iv) {
        let secret: string
        try {
          secret = await decryptSecret(totpUser.totp_secret_ciphertext, totpUser.totp_secret_iv, encryptionKey)
        } catch {
          return jsonResponse({ error: 'service_unavailable' }, 503)
        }
        const step = await verifyTotpCode(secret, code, totpUser.totp_last_step, now.getTime())
        if (step !== null && await totpRepository.updateLastStep(user.id, step)) {
          verified = true
        }
      }

      if (!verified) {
        await recordLoginFailure(authRepository, user.username, ipHash, now)
        return jsonResponse({ error: 'invalid_code' }, 401)
      }

      await totpRepository.disableTotp(user.id, now.toISOString())
      await totpRepository.deleteRecoveryCodes(user.id)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('TOTP disable request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createTotpDisableHandler()
