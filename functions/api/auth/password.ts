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

interface PasswordDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
}

export function createPasswordHandler(
  overrides: Partial<PasswordDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PasswordDependencies = {
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

    let payload: { currentPassword?: unknown, newPassword?: unknown }
    try {
      const body = await context.request.text()
      if (body.length > 2048) return jsonResponse({ error: 'invalid_request' }, 400)
      payload = JSON.parse(body) as typeof payload
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }
    if (
      typeof payload.currentPassword !== 'string'
      || typeof payload.newPassword !== 'string'
      || payload.newPassword.length < 12
      || payload.newPassword.length > 256
      || payload.newPassword === payload.currentPassword
    ) {
      return jsonResponse({ error: 'weak_password' }, 400)
    }

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(repository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      const stored = await repository.findUser(user.username)
      if (!stored) return jsonResponse({ error: 'invalid_credentials' }, 400)

      const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const ipHash = await sha256(ip)
      const now = new Date()
      const attempt = await getLoginAttempt(repository, user.username, ipHash)
      if (isLoginBlocked(attempt, now)) return jsonResponse({ error: 'invalid_credentials' }, 400)

      const matches = await verifyPassword(
        payload.currentPassword,
        stored.password_hash,
        stored.password_salt,
        stored.password_iterations,
      )
      if (!matches) {
        await recordLoginFailure(repository, user.username, ipHash, now)
        return jsonResponse({ error: 'invalid_credentials' }, 400)
      }

      const timestamp = now.toISOString()
      const password = await hashPassword(payload.newPassword)
      await repository.updatePassword(
        user.id,
        password.hash,
        password.salt,
        password.iterations,
        0,
        timestamp,
      )
      await repository.revokeOtherSessions(user.id, user.sessionId)
      return jsonResponse({ ok: true })
    } catch (error) {
      console.error('Password change request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createPasswordHandler()
