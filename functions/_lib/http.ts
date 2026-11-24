export const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
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

export function contentDisposition(fileName: string, type: 'attachment' | 'inline' = 'attachment') {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\\r\n/;]/gu, '_')
    .trim()
    .slice(0, 180) || 'download'
  const encoded = encodeURIComponent(fileName)
    .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

// SVG can carry scripts, so it is never rendered inline on this origin.
export function allowsInlineContentType(contentType: string) {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (type === 'image/svg+xml') return false
  return type.startsWith('image/')
    || type.startsWith('video/')
    || type.startsWith('audio/')
    || type === 'application/pdf'
    || type === 'text/plain'
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
