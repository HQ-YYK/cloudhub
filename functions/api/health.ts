import type { PagesFunction } from '@cloudflare/workers-types'

interface Env {
  DB?: D1Database
}

type HealthResponse = {
  ok: boolean
  service: 'cloudhub-api'
  database: 'connected' | 'unavailable'
}

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
}

function jsonResponse(body: HealthResponse, status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...jsonHeaders,
      ...headers,
    },
  })
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'GET') {
    return jsonResponse(
      {
        ok: false,
        service: 'cloudhub-api',
        database: 'unavailable',
      },
      405,
      { Allow: 'GET' },
    )
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
