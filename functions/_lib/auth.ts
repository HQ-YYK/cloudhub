import type { D1Database, PagesFunction } from '@cloudflare/workers-types'

export const PASSWORD_ITERATIONS = 310000
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_LOGIN_FAILURES = 5
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_BLOCK_MS = 15 * 60 * 1000

export interface AuthEnv {
  DB?: D1Database
}

export interface PublicUser {
  id: string
  username: string
}

interface StoredUser extends PublicUser {
  password_hash: string
  password_salt: string
  password_iterations: number
  disabled: number
}

interface SessionUser extends PublicUser {
  session_id: string
}

interface LoginAttempt {
  failed_count: number
  window_started_at: string
  blocked_until: string | null
}

const encoder = new TextEncoder()

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return bytesToBase64Url(new Uint8Array(digest))
}

export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  )
  return {
    hash: bytesToBase64Url(new Uint8Array(bits)),
    salt: bytesToBase64Url(salt),
    iterations,
  }
}

export async function verifyPassword(password: string, storedHash: string, storedSalt: string, iterations: number) {
  try {
    const result = await hashPassword(password, base64UrlToBytes(storedSalt), iterations)
    return constantTimeEqual(base64UrlToBytes(result.hash), base64UrlToBytes(storedHash))
  } catch {
    return false
  }
}

export function createSessionToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashSessionToken(token: string) {
  return sha256(token)
}

function parseCookies(cookieHeader: string | null) {
  const cookies = new Map<string, string>()
  for (const part of cookieHeader?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    cookies.set(name, decodeURIComponent(value))
  }
  return cookies
}

export function getSessionToken(request: Request) {
  return parseCookies(request.headers.get('Cookie')).get('cloudhub_session') ?? null
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_MS / 1000) {
  return `cloudhub_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`
}

export function clearSessionCookie() {
  return sessionCookie('', 0)
}

export async function getAuthenticatedUser(db: D1Database, request: Request, now = new Date()) {
  const token = getSessionToken(request)
  if (!token) return null

  const tokenHash = await hashSessionToken(token)
  const row = await db.prepare(`
    SELECT s.id AS session_id, u.id, u.username
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
      AND u.disabled = 0
    LIMIT 1
  `).bind(tokenHash, now.toISOString()).first<SessionUser>()

  if (!row) return null

  await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now.toISOString(), row.session_id)
    .run()

  return { id: row.id, username: row.username } satisfies PublicUser
}

export async function getLoginAttempt(db: D1Database, username: string, ipHash: string) {
  return db.prepare(`
    SELECT failed_count, window_started_at, blocked_until
    FROM login_attempts
    WHERE username_key = ? AND ip_hash = ?
  `).bind(username.toLowerCase(), ipHash).first<LoginAttempt>()
}

export function isLoginBlocked(attempt: LoginAttempt | null, now = new Date()) {
  return Boolean(attempt?.blocked_until && new Date(attempt.blocked_until).getTime() > now.getTime())
}

export async function recordLoginFailure(db: D1Database, username: string, ipHash: string, now = new Date()) {
  const current = await getLoginAttempt(db, username, ipHash)
  const nowMs = now.getTime()
  const windowStart = current && nowMs - new Date(current.window_started_at).getTime() < LOGIN_WINDOW_MS
    ? current.window_started_at
    : now.toISOString()
  const failedCount = current && windowStart === current.window_started_at ? current.failed_count + 1 : 1
  const blockedUntil = failedCount >= MAX_LOGIN_FAILURES
    ? new Date(nowMs + LOGIN_BLOCK_MS).toISOString()
    : null

  await db.prepare(`
    INSERT INTO login_attempts (username_key, ip_hash, failed_count, window_started_at, blocked_until)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username_key, ip_hash) DO UPDATE SET
      failed_count = excluded.failed_count,
      window_started_at = excluded.window_started_at,
      blocked_until = excluded.blocked_until
  `).bind(username.toLowerCase(), ipHash, failedCount, windowStart, blockedUntil).run()
}

export async function clearLoginFailures(db: D1Database, username: string, ipHash: string) {
  await db.prepare('DELETE FROM login_attempts WHERE username_key = ? AND ip_hash = ?')
    .bind(username.toLowerCase(), ipHash).run()
}

export async function findUser(db: D1Database, username: string) {
  return db.prepare(`
    SELECT id, username, password_hash, password_salt, password_iterations, disabled
    FROM users
    WHERE username = ?
    LIMIT 1
  `).bind(username).first<StoredUser>()
}

export const withAuthEnv = <T extends AuthEnv>(handler: PagesFunction<T>) => handler
