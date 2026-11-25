import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../_lib/auth.ts'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1TotpRepository } from '../../../_lib/d1-totp-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { decryptSecret } from '../../../_lib/secret-box.ts'
import { generateRecoveryCodes, verifyTotpCode } from '../../../_lib/totp.ts'
import type { TotpRepository } from '../../../_lib/totp-repository.ts'

const MAX_BODY_LENGTH = 2048

interface TotpEnableDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTotpRepository: (env: AuthEnv) => TotpRepository
}

export function createTotpEnableHandler(
  overrides: Partial<TotpEnableDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: TotpEnableDependencies = {
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

    let payload: { code?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }
    if (typeof payload.code !== 'string') {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const totpRepository = dependencies.createTotpRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.mustChangePassword) return jsonResponse({ error: 'password_change_required' }, 403)

      const totpUser = await totpRepository.findTotpUser(user.id)
      if (!totpUser) return jsonResponse({ error: 'service_unavailable' }, 503)
      if (!totpUser.totp_pending_ciphertext || !totpUser.totp_pending_iv) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }

      let secret: string
      try {
        secret = await decryptSecret(totpUser.totp_pending_ciphertext, totpUser.totp_pending_iv, encryptionKey)
      } catch {
        return jsonResponse({ error: 'service_unavailable' }, 503)
      }

      const now = new Date()
      const step = await verifyTotpCode(secret, payload.code, null, now.getTime())
      if (step === null) return jsonResponse({ error: 'invalid_code' }, 400)

      await totpRepository.enableTotp(
        user.id,
        totpUser.totp_pending_ciphertext,
        totpUser.totp_pending_iv,
        now.toISOString(),
      )
      await totpRepository.deleteRecoveryCodes(user.id)
      const recoveryCodes = await generateRecoveryCodes()
      await totpRepository.createRecoveryCodes(recoveryCodes.map((code) => ({
        id: crypto.randomUUID(),
        userId: user.id,
        codeHash: code.codeHash,
        createdAt: now.toISOString(),
      })))
      return jsonResponse({ recoveryCodes: recoveryCodes.map((code) => code.code) })
    } catch (error) {
      console.error('TOTP enable request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createTotpEnableHandler()
