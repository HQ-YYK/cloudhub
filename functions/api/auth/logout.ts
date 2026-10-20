import type { PagesFunction } from '@cloudflare/workers-types'
import { getSessionToken, hashSessionToken, clearSessionCookie, type AuthEnv } from '../../../functions/_lib/auth.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../functions/_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed('POST')
  if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

  try {
    const token = getSessionToken(context.request)
    if (token) {
      await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(await hashSessionToken(token)).run()
    }
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
  } catch (error) {
    console.error('Logout request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
