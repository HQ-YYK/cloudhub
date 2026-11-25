import type { PagesFunction } from '@cloudflare/workers-types'
import { AuthRepositoryConflictError, type AuthRepository } from '../../../_lib/auth-repository.ts'
import { getAuthenticatedUser, hashPassword, MIN_INITIAL_PASSWORD_LENGTH } from '../../../_lib/auth.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'

interface AdminUsersDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
}

export function createAdminUsersHandler(
  overrides: Partial<AdminUsersDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: AdminUsersDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET' && context.request.method !== 'POST') {
      return methodNotAllowed(context.request.method === 'GET' ? 'GET' : 'GET, POST')
    }
    if (context.request.method === 'POST' && !sameOriginRequest(context.request)) {
      return jsonResponse({ error: 'forbidden' }, 403)
    }
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const repository = dependencies.createAuthRepository(context.env)
      const admin = await getAuthenticatedUser(repository, context.request)
      if (!admin) return jsonResponse({ error: 'unauthorized' }, 401)
      if (admin.role !== 'admin' || admin.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      if (context.request.method === 'GET') {
        return jsonResponse({ users: await repository.listUsers() })
      }

      let payload: { username?: unknown, password?: unknown }
      try {
        const body = await context.request.text()
        if (body.length > 2048) return jsonResponse({ error: 'invalid_request' }, 400)
        payload = JSON.parse(body) as typeof payload
      } catch {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      if (
        typeof payload.username !== 'string'
        || !/^[A-Za-z0-9_.-]{1,32}$/u.test(payload.username)
      ) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      if (
        typeof payload.password !== 'string'
        || payload.password.length < MIN_INITIAL_PASSWORD_LENGTH
        || payload.password.length > 256
      ) {
        return jsonResponse({ error: 'weak_password' }, 400)
      }

      const password = await hashPassword(payload.password)
      const timestamp = new Date().toISOString()
      const created = await repository.createUser({
        id: crypto.randomUUID(),
        username: payload.username,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordIterations: password.iterations,
        role: 'user',
        mustChangePassword: 1,
        createdAt: timestamp,
      })
      return jsonResponse({ user: created }, 201)
    } catch (error) {
      if (error instanceof AuthRepositoryConflictError) {
        return jsonResponse({ error: 'username_taken' }, 409)
      }
      console.error('Admin users request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createAdminUsersHandler()
