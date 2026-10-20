import type { PagesFunction } from '@cloudflare/workers-types'
import { getSessionToken, hashSessionToken, clearSessionCookie, deleteSessionByTokenHash } from '../../../functions/_lib/auth.ts'
import { createD1AuthRepository } from '../../../functions/_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../functions/_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../functions/_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed('POST')
  if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
  const repository = createD1AuthRepository(context.env.DB)

  try {
    const token = getSessionToken(context.request)
    if (token) {
      await deleteSessionByTokenHash(repository, await hashSessionToken(token))
    }
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
  } catch (error) {
    console.error('Logout request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
