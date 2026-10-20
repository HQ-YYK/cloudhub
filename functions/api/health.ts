import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed } from '../_lib/http.ts'

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'GET') {
    return methodNotAllowed('GET')
  }

  if (!context.env.DB) {
    return jsonResponse({
      ok: false,
      service: 'cloudhub-api',
      database: 'unavailable',
    }, 503)
  }

  try {
    await context.env.DB.prepare('SELECT 1 AS ok').first()

    return jsonResponse({
      ok: true,
      service: 'cloudhub-api',
      database: 'connected',
    }, 200)
  } catch (error) {
    console.error('Health check database query failed', error)

    return jsonResponse({
      ok: false,
      service: 'cloudhub-api',
      database: 'unavailable',
    }, 503)
  }
}
