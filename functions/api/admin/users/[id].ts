import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import { getAuthenticatedUser } from '../../../_lib/auth.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'

interface AdminUserDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
}

export function createAdminUserHandler(
  overrides: Partial<AdminUserDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: AdminUserDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'PATCH') return methodNotAllowed('PATCH')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const admin = await getAuthenticatedUser(repository, context.request)
      if (!admin) return jsonResponse({ error: 'unauthorized' }, 401)
      if (admin.role !== 'admin' || admin.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      const id = context.params.id
      if (typeof id !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)
      const target = await repository.findUserById(id)
      if (!target) return jsonResponse({ error: 'not_found' }, 404)
      if (target.role === 'admin') return jsonResponse({ error: 'forbidden' }, 403)

      let payload: { disabled?: unknown }
      try {
        const body = await context.request.text()
        if (body.length > 2048) return jsonResponse({ error: 'invalid_request' }, 400)
        payload = JSON.parse(body) as typeof payload
      } catch {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      if (typeof payload.disabled !== 'boolean') {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }

      const timestamp = new Date().toISOString()
      await repository.setDisabled(id, payload.disabled ? 1 : 0, timestamp)
      if (payload.disabled) await repository.revokeAllSessions(id)
      const updated = await repository.findUserById(id)
      return jsonResponse({ user: updated })
    } catch (error) {
      console.error('Admin user update request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createAdminUserHandler()
