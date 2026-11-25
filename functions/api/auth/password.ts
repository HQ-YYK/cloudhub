import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import {
  getAuthenticatedUser,
  getLoginAttempt,
  hashPassword,
  isLoginBlocked,
  recordLoginFailure,
  sha256,
  verifyPassword,
} from '../../_lib/auth.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import {
  createD1KeysRepository,
  isValidAuthKey,
  isValidKdfSalt,
  isValidWrappedKey,
  KDF_ITERATIONS,
  type KeysRepository,
} from '../../_lib/keys.ts'

const MAX_BODY_LENGTH = 4096

interface PasswordDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createKeysRepository: (env: AuthEnv) => KeysRepository
}

export function createPasswordHandler(
  overrides: Partial<PasswordDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PasswordDependencies = {
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

    let payload: {
      currentAuthKey?: unknown
      currentPassword?: unknown
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
      !isValidKdfSalt(payload.newKdfSalt) ||
      !isValidAuthKey(payload.newAuthKey) ||
      !isValidWrappedKey(payload.wrappedMasterKey)
    ) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    let recoveryWrappedKey: string | undefined
    if (payload.recoveryWrappedKey !== undefined) {
      if (!isValidWrappedKey(payload.recoveryWrappedKey)) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      recoveryWrappedKey = payload.recoveryWrappedKey
    }

    const newKdfSalt = payload.newKdfSalt
    const newAuthKey = payload.newAuthKey
    const wrappedMasterKey = payload.wrappedMasterKey

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const keysRepository = dependencies.createKeysRepository(context.env)
      const user = await getAuthenticatedUser(repository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      const stored = await repository.findUser(user.username)
      if (!stored) return jsonResponse({ error: 'invalid_credentials' }, 400)

      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const ipHash = await sha256(ip)
      const now = new Date()
      const attempt = await getLoginAttempt(repository, user.username, ipHash)
      if (isLoginBlocked(attempt, now)) return jsonResponse({ error: 'invalid_credentials' }, 400)

      const legacy = stored.kdf_salt === null
      let credentialMatches = false
      if (legacy) {
        const currentPassword = payload.currentPassword
        if (typeof currentPassword !== 'string' || currentPassword.length < 1 || currentPassword.length > 256) {
          return jsonResponse({ error: 'invalid_request' }, 400)
        }
        credentialMatches = await verifyPassword(
          currentPassword,
          stored.password_hash,
          stored.password_salt,
          stored.password_iterations,
        )
      } else {
        if (!isValidAuthKey(payload.currentAuthKey)) {
          return jsonResponse({ error: 'invalid_request' }, 400)
        }
        credentialMatches = await verifyPassword(
          payload.currentAuthKey,
          stored.password_hash,
          stored.password_salt,
          stored.password_iterations,
        )
      }

      if (!credentialMatches) {
        await recordLoginFailure(repository, user.username, ipHash, now)
        return jsonResponse({ error: 'invalid_credentials' }, 400)
      }

      const hasKeys = stored.wrapped_master_key !== null
      if (!hasKeys && recoveryWrappedKey === undefined) {
        return jsonResponse({ error: 'invalid_request' }, 400)
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
        recoveryWrappedKey: recoveryWrappedKey ?? stored.recovery_wrapped_key,
        mustChangePassword: 0,
        keysUpdatedAt: timestamp,
        updatedAt: timestamp,
      })
      await repository.revokeOtherSessions(user.id, user.sessionId)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Password change request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasswordHandler()
