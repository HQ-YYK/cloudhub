import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../functions/_lib/auth.ts'
import type { AuthRepository } from '../../../functions/_lib/auth-repository.ts'
import type { AuthEnv } from '../../../functions/_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../functions/_lib/d1-auth-repository.ts'
import { createD1TotpRepository } from '../../../functions/_lib/d1-totp-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../../functions/_lib/http.ts'
import type { TotpRepository } from '../../../functions/_lib/totp-repository.ts'

interface MeDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTotpRepository: (env: AuthEnv) => TotpRepository
}

export function createMeHandler(
  overrides: Partial<MeDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: MeDependencies = {
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
    if (context.request.method !== 'GET') return methodNotAllowed('GET')
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const totpUser = await dependencies.createTotpRepository(context.env).findTotpUser(user.id)
      return jsonResponse({ user: {
        id: user.id,
        username: user.username,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        keysReady: user.keysReady,
        totpEnabled: Boolean(totpUser?.totp_secret_ciphertext),
      } })
    } catch (error) {
      console.error('Session lookup failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createMeHandler()
