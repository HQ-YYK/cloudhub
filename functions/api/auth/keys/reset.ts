import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import {
  getAuthenticatedUser,
  getLoginAttempt,
  hashPassword,
  isLoginBlocked,
  recordLoginFailure,
  sha256,
  verifyPassword,
} from '../../../_lib/auth.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1PasskeyRepository } from '../../../_lib/d1-passkey-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import {
  createD1KeysRepository,
  isValidAuthKey,
  isValidKdfSalt,
  isValidWrappedKey,
  KDF_ITERATIONS,
  type KeysRepository,
} from '../../../_lib/keys.ts'
import type { PasskeyRepository } from '../../../_lib/passkey-repository.ts'

const MAX_BODY_LENGTH = 4096

interface ResetDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createKeysRepository: (env: AuthEnv) => KeysRepository
  createPasskeyRepository: (env: AuthEnv) => PasskeyRepository
}

export function createKeysResetHandler(
  overrides: Partial<ResetDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: ResetDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createKeysRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1KeysRepository(env.DB)
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

    let payload: {
      currentAuthKey?: unknown
      newKdfSalt?: unknown
      newAuthKey?: unknown
      wrappedMasterKey?: unknown
      recoveryWrappedKey?: unknown
    }
    try {
      const body = await context.request.text()
      if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (
      !isValidAuthKey(payload.currentAuthKey) ||
      !isValidKdfSalt(payload.newKdfSalt) ||
      !isValidAuthKey(payload.newAuthKey) ||
      !isValidWrappedKey(payload.wrappedMasterKey) ||
      !isValidWrappedKey(payload.recoveryWrappedKey)
    ) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    const currentAuthKey = payload.currentAuthKey
    const newKdfSalt = payload.newKdfSalt
    const newAuthKey = payload.newAuthKey
    const wrappedMasterKey = payload.wrappedMasterKey
    const recoveryWrappedKey = payload.recoveryWrappedKey

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const keysRepository = dependencies.createKeysRepository(context.env)
      const passkeyRepository = dependencies.createPasskeyRepository(context.env)
      const user = await getAuthenticatedUser(repository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      const stored = await repository.findUser(user.username)
      if (!stored) return jsonResponse({ error: 'unauthorized' }, 401)

      if (stored.must_change_password !== 1 || stored.kdf_salt === null) {
        return jsonResponse({ error: 'reset_not_allowed' }, 409)
      }

      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const ipHash = await sha256(ip)
      const now = new Date()
      const attempt = await getLoginAttempt(repository, user.username, ipHash)
      if (isLoginBlocked(attempt, now)) return jsonResponse({ error: 'invalid_credentials' }, 400)

      const credentialMatches = await verifyPassword(
        currentAuthKey,
        stored.password_hash,
        stored.password_salt,
        stored.password_iterations,
      )
      if (!credentialMatches) {
        await recordLoginFailure(repository, user.username, ipHash, now)
        return jsonResponse({ error: 'invalid_credentials' }, 400)
      }

      const timestamp = now.toISOString()
      const password = await hashPassword(newAuthKey)
      await keysRepository.updateKeys(user.id, {
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordIterations: password.iterations,
        kdfSalt: newKdfSalt,
        kdfIterations: KDF_ITERATIONS,
        wrappedMasterKey,
        recoveryWrappedKey,
        mustChangePassword: 0,
        keysUpdatedAt: timestamp,
        updatedAt: timestamp,
      })
      await passkeyRepository.clearPrfWrappedKeys(user.id)
      await repository.revokeOtherSessions(user.id, user.sessionId)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Key reset request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createKeysResetHandler()
