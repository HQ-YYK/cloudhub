import type { PagesFunction } from '@cloudflare/workers-types'
import {
  clearLoginFailures,
  createSession,
  createSessionToken,
  findUser,
  getLoginAttempt,
  hashSessionToken,
  isLoginBlocked,
  recordLoginFailure,
  sessionCookie,
  sha256,
  verifyPassword,
} from '../../../functions/_lib/auth.ts'
import { createD1AuthRepository } from '../../../functions/_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../functions/_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../functions/_lib/http.ts'

const INVALID_LOGIN = { error: 'invalid_credentials' }
const MAX_BODY_LENGTH = 2048

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed('POST')
  if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
  const repository = createD1AuthRepository(context.env.DB)

  let payload: { username?: unknown; password?: unknown }
  try {
    const body = await context.request.text()
    if (body.length > MAX_BODY_LENGTH) return jsonResponse({ error: 'invalid_request' }, 400)
    payload = JSON.parse(body) as { username?: unknown; password?: unknown }
  } catch {
    return jsonResponse({ error: 'invalid_request' }, 400)
  }

  if (
    typeof payload.username !== 'string' ||
    typeof payload.password !== 'string' ||
    payload.username.length < 1 ||
    payload.username.length > 128 ||
    payload.password.length < 1 ||
    payload.password.length > 256
  ) {
    return jsonResponse({ error: 'invalid_request' }, 400)
  }

  const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const ipHash = await sha256(ip)
  const now = new Date()

  try {
    const attempt = await getLoginAttempt(repository, payload.username, ipHash)
    if (isLoginBlocked(attempt, now)) return jsonResponse(INVALID_LOGIN, 401)

    const user = await findUser(repository, payload.username)
    const passwordRecord = user ?? {
      password_hash: 'A'.repeat(43),
      password_salt: 'A'.repeat(22),
      password_iterations: 310000,
      disabled: 1,
    }
    const passwordMatches = await verifyPassword(
      payload.password,
      passwordRecord.password_hash,
      passwordRecord.password_salt,
      passwordRecord.password_iterations,
    )
    const valid = Boolean(user && user.disabled === 0 && passwordMatches)

    if (!valid || !user) {
      await recordLoginFailure(repository, payload.username, ipHash, now)
      return jsonResponse(INVALID_LOGIN, 401)
    }

    const token = createSessionToken()
    const tokenHash = await hashSessionToken(token)
    const timestamp = now.toISOString()
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

    await createSession(repository, {
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      createdAt: timestamp,
      expiresAt,
      lastSeenAt: timestamp,
    })
    await clearLoginFailures(repository, payload.username, ipHash)

    return jsonResponse({ user: { id: user.id, username: user.username } }, 200, {
      'Set-Cookie': sessionCookie(token),
    })
  } catch (error) {
    console.error('Login request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
