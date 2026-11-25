import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../_lib/auth.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../_lib/http.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'

export function createStorageStatusHandler(
  overrides: Partial<{ createAuthRepository: (env: AuthEnv) => ReturnType<typeof createD1AuthRepository>, createStorageRepository: (env: AuthEnv) => StorageRepository }> = {},
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
      const accounts = await dependencies.createStorageRepository(context.env).listAccounts()
      return jsonResponse({
        connected: accounts.some((account) => account.status === 'active'),
        accountCount: accounts.length,
      })
    } catch (error) {
      console.error('Storage status failed', error instanceof Error ? error.name : 'unknown_error')
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createStorageStatusHandler()
