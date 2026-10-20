import type { PagesFunction } from '@cloudflare/workers-types'
import {
  clearSessionCookie,
  getAuthenticatedUser,
  revokeAllSessions,
  type AuthEnv,
} from '../../../functions/_lib/auth.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../functions/_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed('POST')
  if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

  try {
    const user = await getAuthenticatedUser(context.env.DB, context.request)
    if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

    await revokeAllSessions(context.env.DB, user.id)
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
  } catch (error) {
    console.error('All-session logout request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
