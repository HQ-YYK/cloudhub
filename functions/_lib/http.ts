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

// Exact list of types safe to render inline on this origin. SVG, HTML and XML are excluded.
const INLINE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'application/pdf',
  'text/plain',
])

export const INLINE_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"

export function normalizeMimeType(contentType: string | null | undefined): string | null {
  if (!contentType || /[,\r\n]/u.test(contentType)) return null
  const type = contentType.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(type) ? type : null
}

export function allowsInlineContentType(contentType: string | null | undefined) {
  const type = normalizeMimeType(contentType)
  return type !== null && INLINE_CONTENT_TYPES.has(type)
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
