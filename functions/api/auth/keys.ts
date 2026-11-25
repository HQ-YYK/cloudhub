import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../_lib/auth.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../_lib/http.ts'

interface KeysDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
}

export function createKeysHandler(
  overrides: Partial<KeysDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: KeysDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET') return methodNotAllowed('GET')
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(repository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const stored = await repository.findUser(user.username)
      if (!stored) return jsonResponse({ error: 'unauthorized' }, 401)

      return jsonResponse({
        legacy: stored.kdf_salt === null,
        kdfSalt: stored.kdf_salt,
        kdfIterations: stored.kdf_iterations,
        wrappedMasterKey: stored.wrapped_master_key,
        recoveryWrappedKey: stored.recovery_wrapped_key,
      })
    } catch (error) {
      console.error('Keys request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createKeysHandler()
