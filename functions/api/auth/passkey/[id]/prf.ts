import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../../_lib/auth.ts'
import type { AuthRepository } from '../../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../../_lib/d1-passkey-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../../_lib/http.ts'
import type { PasskeyRepository } from '../../../../_lib/passkey-repository.ts'
import { isValidPrfWrappedKey } from '../../../../_lib/webauthn.ts'

const MAX_BODY_LENGTH = 2048

interface PrfDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createPasskeyPrfHandler(
  overrides: Partial<PrfDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PrfDependencies = {
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
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    let payload: { prfWrappedMasterKey?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (!isValidPrfWrappedKey(payload.prfWrappedMasterKey)) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

      const id = context.params.id
      if (typeof id !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)

      const passkey = await passkeyRepository.findPasskeyById(id)
      if (!passkey || passkey.user_id !== user.id) return jsonResponse({ error: 'not_found' }, 404)
      if (passkey.prf_wrapped_master_key !== null) return jsonResponse({ error: 'prf_already_set' }, 409)

      const updated = await passkeyRepository.setPrfWrappedKey(user.id, id, payload.prfWrappedMasterKey)
      if (!updated) return jsonResponse({ error: 'prf_already_set' }, 409)

      return new Response(null, { status: 204 })
    } catch (error) {
      console.error('Passkey PRF update request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasskeyPrfHandler()
