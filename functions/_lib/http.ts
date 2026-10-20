export const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...headers },
  })
}

export function methodNotAllowed(allow: string) {
  return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: allow })
}

export function sameOriginRequest(request: Request) {
  const origin = request.headers.get('Origin')
  if (origin) return origin === new URL(request.url).origin

  const referer = request.headers.get('Referer')
  if (!referer) return false
  try {
    return new URL(referer).origin === new URL(request.url).origin
  } catch {
    return false
  }
}
