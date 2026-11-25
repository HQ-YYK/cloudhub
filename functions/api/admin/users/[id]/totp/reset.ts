import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser, revokeAllSessions } from '../../../../../_lib/auth.ts'
import type { AuthRepository } from '../../../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../../../_lib/d1-auth-repository.ts'
import { createD1TotpRepository } from '../../../../../_lib/d1-totp-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../../_lib/http.ts'
import type { TotpRepository } from '../../../../../_lib/totp-repository.ts'

interface AdminTotpResetDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTotpRepository: (env: AuthEnv) => TotpRepository
}

export function createAdminTotpResetHandler(
  overrides: Partial<AdminTotpResetDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: AdminTotpResetDependencies = {
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

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const totpRepository = dependencies.createTotpRepository(context.env)
      const admin = await getAuthenticatedUser(authRepository, context.request)
      if (!admin) return jsonResponse({ error: 'unauthorized' }, 401)
      if (admin.role !== 'admin' || admin.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      const id = context.params.id
      if (typeof id !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)
      if (id === admin.id) return jsonResponse({ error: 'invalid_request' }, 400)

      const target = await authRepository.findUserById(id)
      if (!target) return jsonResponse({ error: 'not_found' }, 404)
      if (target.role === 'admin') return jsonResponse({ error: 'forbidden' }, 403)

      const now = new Date().toISOString()
      await totpRepository.disableTotp(id, now)
      await totpRepository.deleteRecoveryCodes(id)
      await revokeAllSessions(authRepository, id)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Admin TOTP reset request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createAdminTotpResetHandler()
