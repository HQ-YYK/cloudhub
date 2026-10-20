import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser, type AuthEnv } from '../../../functions/_lib/auth.ts'
import { jsonResponse, methodNotAllowed } from '../../../functions/_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'GET') return methodNotAllowed('GET')
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

  try {
    const user = await getAuthenticatedUser(context.env.DB, context.request)
    return user
      ? jsonResponse({ user })
      : jsonResponse({ error: 'unauthorized' }, 401)
  } catch (error) {
    console.error('Session lookup failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
