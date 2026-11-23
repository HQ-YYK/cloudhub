import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../_lib/auth.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import { clearAccessTokenCache } from '../../_lib/google-oauth.ts'
import { decryptSecret } from '../../_lib/secret-box.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'

export function createStorageDisconnectHandler(
  overrides: Partial<{
    createAuthRepository: (env: AuthEnv) => ReturnType<typeof createD1AuthRepository>
    createStorageRepository: (env: AuthEnv) => ReturnType<typeof createD1StorageRepository>
    fetchImpl: typeof fetch
  }> = {},
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
    fetchImpl: fetch,
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.role !== 'admin' || user.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      const storageRepository = dependencies.createStorageRepository(context.env)
      const account = await storageRepository.getAccount()
      if (account && context.env.STORAGE_ENCRYPTION_KEY) {
        try {
          const refreshToken = await decryptSecret(
            account.refresh_token_ciphertext,
            account.refresh_token_iv,
            context.env.STORAGE_ENCRYPTION_KEY,
          )
          await dependencies.fetchImpl('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken }),
          })
        } catch {
          // Revocation is best effort.
        }
      }
      await storageRepository.deleteAccount()
      clearAccessTokenCache()
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Storage disconnect failed', error instanceof Error ? error.name : 'unknown_error')
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createStorageDisconnectHandler()
