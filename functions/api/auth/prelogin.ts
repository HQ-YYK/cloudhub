import type { PagesFunction } from '@cloudflare/workers-types'
import { findUser } from '../../_lib/auth.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import { deriveFakeSalt, KDF_ITERATIONS } from '../../_lib/keys.ts'

const MAX_BODY_LENGTH = 2048

interface PreloginDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
}

export function createPreloginHandler(
  overrides: Partial<PreloginDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PreloginDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
    if (!context.env.STORAGE_ENCRYPTION_KEY) return jsonResponse({ error: 'service_unavailable' }, 503)

    let payload: { username?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (
      typeof payload.username !== 'string' ||
      payload.username.length < 1 ||
      payload.username.length > 128
    ) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const user = await findUser(repository, payload.username)

      if (user && user.disabled === 0 && user.kdf_salt !== null) {
        return jsonResponse({
          legacy: false,
          kdfSalt: user.kdf_salt,
          kdfIterations: user.kdf_iterations ?? KDF_ITERATIONS,
        })
      }

      if (user && user.disabled === 0) {
        return jsonResponse({ legacy: true })
      }

      const fakeSalt = await deriveFakeSalt(context.env.STORAGE_ENCRYPTION_KEY, payload.username)
      return jsonResponse({
        legacy: false,
        kdfSalt: fakeSalt,
        kdfIterations: KDF_ITERATIONS,
      })
    } catch (error) {
      console.error('Prelogin request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPreloginHandler()
