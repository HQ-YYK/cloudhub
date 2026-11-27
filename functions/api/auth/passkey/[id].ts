import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../_lib/auth.ts'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../_lib/passkey-repository.ts'

const MAX_BODY_LENGTH = 2048

interface PasskeyIdDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createPasskeyIdHandler(
  overrides: Partial<PasskeyIdDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PasskeyIdDependencies = {
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
    const method = context.request.method
    if (method !== 'PATCH' && method !== 'DELETE') return methodNotAllowed('PATCH, DELETE')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const id = context.params.id
      if (typeof id !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)

      const passkey = await passkeyRepository.findPasskeyById(id)
      if (!passkey || passkey.user_id !== user.id) return jsonResponse({ error: 'not_found' }, 404)

      if (method === 'DELETE') {
        await passkeyRepository.deletePasskey(user.id, id)
        return new Response(null, { status: 204 })
      }

      let payload: { name?: unknown }
      try {
        const body = await context.request.text()
        if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
        payload = JSON.parse(body) as typeof payload
      } catch {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }

      if (typeof payload.name !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)
      const name = payload.name.trim()
      if (name.length < 1 || name.length > 64) return jsonResponse({ error: 'invalid_request' }, 400)

      await passkeyRepository.updatePasskeyName(user.id, id, name)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Passkey update request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasskeyIdHandler()
