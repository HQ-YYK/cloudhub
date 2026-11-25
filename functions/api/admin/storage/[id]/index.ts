import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../../_lib/auth.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { clearAccessTokenCache } from '../../../../_lib/google-oauth.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import { defaultStorageAdminDependencies, type StorageAdminDependencies } from '../deps.ts'

function parseAccountId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function createAdminStorageDeleteHandler(
  overrides: Partial<StorageAdminDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: StorageAdminDependencies = { ...defaultStorageAdminDependencies, ...overrides }

  return async (context) => {
    if (context.request.method !== 'DELETE') return methodNotAllowed('DELETE')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    const accountId = parseAccountId(context.params.id)
    if (accountId === null) return jsonResponse({ error: 'invalid_request' }, 400)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.role !== 'admin' || user.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      const storageRepository = dependencies.createStorageRepository(context.env)
      const account = await storageRepository.getAccount(accountId)
      if (!account) return jsonResponse({ error: 'not_found' }, 404)

      const fileCount = await storageRepository.countFilesByAccount(accountId)
      if (fileCount > 0) {
        return jsonResponse({ error: 'account_in_use', fileCount }, 409)
      }

      await storageRepository.deleteAccount(accountId)
      clearAccessTokenCache(accountId)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Admin storage delete request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createAdminStorageDeleteHandler()
