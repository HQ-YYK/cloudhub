import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import {
  getAuthenticatedUser,
  getLoginAttempt,
  isLoginBlocked,
  recordLoginFailure,
  sha256,
  verifyPassword,
} from '../../../_lib/auth.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import {
  createD1KeysRepository,
  isValidAuthKey,
  isValidWrappedKey,
  type KeysRepository,
} from '../../../_lib/keys.ts'

const MAX_BODY_LENGTH = 2048

interface RecoveryDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createKeysRepository: (env: AuthEnv) => KeysRepository
}

export function createKeysRecoveryHandler(
  overrides: Partial<RecoveryDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: RecoveryDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createKeysRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1KeysRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    let payload: { currentAuthKey?: unknown; recoveryWrappedKey?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (!isValidAuthKey(payload.currentAuthKey) || !isValidWrappedKey(payload.recoveryWrappedKey)) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const keysRepository = dependencies.createKeysRepository(context.env)
      const user = await getAuthenticatedUser(repository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      const stored = await repository.findUser(user.username)
      if (!stored) return jsonResponse({ error: 'unauthorized' }, 401)

      if (stored.kdf_salt === null || stored.wrapped_master_key === null) {
        return jsonResponse({ error: 'keys_not_ready' }, 409)
      }

      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const ipHash = await sha256(ip)
      const now = new Date()
      const attempt = await getLoginAttempt(repository, user.username, ipHash)
      if (isLoginBlocked(attempt, now)) return jsonResponse({ error: 'invalid_credentials' }, 400)

      const credentialMatches = await verifyPassword(
        payload.currentAuthKey,
        stored.password_hash,
        stored.password_salt,
        stored.password_iterations,
      )
      if (!credentialMatches) {
        await recordLoginFailure(repository, user.username, ipHash, now)
        return jsonResponse({ error: 'invalid_credentials' }, 400)
      }

      const timestamp = now.toISOString()
      await keysRepository.updateRecoveryKey(user.id, payload.recoveryWrappedKey, timestamp, timestamp)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Recovery key regeneration request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createKeysRecoveryHandler()
