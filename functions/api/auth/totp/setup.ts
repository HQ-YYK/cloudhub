import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../_lib/auth.ts'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1TotpRepository } from '../../../_lib/d1-totp-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { encryptSecret } from '../../../_lib/secret-box.ts'
import { generateTotpSecret, otpauthUrl } from '../../../_lib/totp.ts'
import type { TotpRepository } from '../../../_lib/totp-repository.ts'

interface TotpSetupDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTotpRepository: (env: AuthEnv) => TotpRepository
}

export function createTotpSetupHandler(
  overrides: Partial<TotpSetupDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: TotpSetupDependencies = {
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

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const totpRepository = dependencies.createTotpRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.mustChangePassword) return jsonResponse({ error: 'password_change_required' }, 403)

      const totpUser = await totpRepository.findTotpUser(user.id)
      if (!totpUser) return jsonResponse({ error: 'service_unavailable' }, 503)
      if (totpUser.totp_secret_ciphertext) return jsonResponse({ error: 'totp_already_enabled' }, 409)

      const secret = generateTotpSecret()
      const encrypted = await encryptSecret(secret, encryptionKey)
      await totpRepository.setPendingSecret(
        user.id,
        encrypted.ciphertext,
        encrypted.iv,
        new Date().toISOString(),
      )
      return jsonResponse({ secret, otpauthUrl: otpauthUrl(user.username, secret) })
    } catch (error) {
      console.error('TOTP setup request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createTotpSetupHandler()
