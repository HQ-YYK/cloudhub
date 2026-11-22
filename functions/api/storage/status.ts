import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../_lib/auth.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../_lib/http.ts'

export function createStorageStatusHandler(
  overrides: Partial<{ createAuthRepository: (env: AuthEnv) => ReturnType<typeof createD1AuthRepository>, createStorageRepository: (env: AuthEnv) => ReturnType<typeof createD1StorageRepository> }> = {},
): PagesFunction<AuthEnv> {
  const dependencies = {
    createAuthRepository: (env: AuthEnv) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createStorageRepository: (env: AuthEnv) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1StorageRepository(env.DB)
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
      if (user.role !== 'admin' || user.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }
      const account = await dependencies.createStorageRepository(context.env).getAccount()
      return jsonResponse({
        connected: Boolean(account),
        email: account?.google_email ?? null,
        connectedAt: account?.created_at ?? null,
      })
    } catch (error) {
      console.error('Storage status failed', error instanceof Error ? error.name : 'unknown_error')
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createStorageStatusHandler()
