import type { PagesFunction } from '@cloudflare/workers-types'
import {
  clearSessionCookie,
  getAuthenticatedUser,
  revokeAllSessions,
} from '../../../functions/_lib/auth.ts'
import { createD1AuthRepository } from '../../../functions/_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../functions/_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../functions/_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed('POST')
  if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
  const repository = createD1AuthRepository(context.env.DB)

  try {
    const user = await getAuthenticatedUser(repository, context.request)
    if (!user) return jsonResponse({ error: 'unauthorized' }, 401)

    await revokeAllSessions(repository, user.id)
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
  } catch (error) {
    console.error('All-session logout request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
