import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../../_lib/auth.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import type { StorageAccountStatus } from '../../../../_lib/storage-repository.ts'
import { defaultStorageAdminDependencies, type StorageAdminDependencies } from '../deps.ts'

function parseAccountId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function createAdminStorageStatusHandler(
  overrides: Partial<StorageAdminDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: StorageAdminDependencies = { ...defaultStorageAdminDependencies, ...overrides }

  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
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

      let payload: { status?: unknown }
      try {
        const body = await context.request.text()
        if (body.length > 64) return jsonResponse({ error: 'invalid_request' }, 400)
        payload = JSON.parse(body) as typeof payload
      } catch {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      if (payload.status !== 'active' && payload.status !== 'readonly') {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }

      const storageRepository = dependencies.createStorageRepository(context.env)
      const updated = await storageRepository.setAccountStatus(
        accountId,
        payload.status as StorageAccountStatus,
        new Date().toISOString(),
      )
      if (!updated) return jsonResponse({ error: 'not_found' }, 404)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Admin storage status request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createAdminStorageStatusHandler()
