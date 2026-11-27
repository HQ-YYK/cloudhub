import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../_lib/auth.ts'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../_lib/passkey-repository.ts'

interface ListPasskeysDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createListPasskeysHandler(
  overrides: Partial<ListPasskeysDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: ListPasskeysDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createPasskeyRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1PasskeyRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET') return methodNotAllowed('GET')
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const passkeys = await passkeyRepository.listPasskeys(user.id)
      return jsonResponse({
        passkeys: passkeys.map((passkey) => ({
          id: passkey.id,
          name: passkey.name,
          createdAt: passkey.created_at,
          lastUsedAt: passkey.last_used_at,
          prf: passkey.prf === 1,
        })),
      })
    } catch (error) {
      console.error('Passkey list request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createListPasskeysHandler()
