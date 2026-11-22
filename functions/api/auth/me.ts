import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../../functions/_lib/auth.ts'
import { createD1AuthRepository } from '../../../functions/_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../functions/_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed } from '../../../functions/_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'GET') return methodNotAllowed('GET')
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
  const repository = createD1AuthRepository(context.env.DB)

  try {
    const user = await getAuthenticatedUser(repository, context.request)
    return user
      ? jsonResponse({ user: {
        id: user.id,
        username: user.username,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      } })
      : jsonResponse({ error: 'unauthorized' }, 401)
  } catch (error) {
    console.error('Session lookup failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
