import type { AuthRepository, LoginAttempt, NewSession } from './auth-repository.ts'

export const PASSWORD_ITERATIONS = 100000
export const MAX_PBKDF2_ITERATIONS = 100000
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_LOGIN_FAILURES = 5
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_BLOCK_MS = 15 * 60 * 1000

export interface PublicUser {
  id: string
  username: string
  role: 'admin' | 'user'
  mustChangePassword: boolean
  sessionId: string
  legacy: boolean
  keysReady: boolean
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
  if (iterations > MAX_PBKDF2_ITERATIONS) {
    throw new Error('pbkdf2_iteration_limit_exceeded')
  }
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
    try {
      cookies.set(name, decodeURIComponent(value))
    } catch {
      continue
    }
  }
  return cookies
}

export function getSessionToken(request: Request) {
  const token = parseCookies(request.headers.get('Cookie')).get('cloudhub_session')
  return token || null
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_MS / 1000) {
  return `cloudhub_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`
}

export function clearSessionCookie() {
  return sessionCookie('', 0)
}

export async function getAuthenticatedUser(repository: AuthRepository, request: Request, now = new Date()) {
  const token = getSessionToken(request)
  if (!token) return null

  const tokenHash = await hashSessionToken(token)
  const row = await repository.findSessionUser(tokenHash, now.toISOString())

  if (!row) return null

  await repository.touchSession(row.session_id, now.toISOString())

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    sessionId: row.session_id,
    legacy: (row.kdf_salt ?? null) === null,
    keysReady: (row.wrapped_master_key ?? null) !== null,
  } satisfies PublicUser
}

export async function getLoginAttempt(repository: AuthRepository, username: string, ipHash: string) {
  return repository.findLoginAttempt(username, ipHash)
}

export function isLoginBlocked(attempt: LoginAttempt | null, now = new Date()) {
  return Boolean(attempt?.blocked_until && new Date(attempt.blocked_until).getTime() > now.getTime())
}

export async function recordLoginFailure(repository: AuthRepository, username: string, ipHash: string, now = new Date()) {
  await repository.recordLoginFailure(
    username,
    ipHash,
    now.toISOString(),
    LOGIN_WINDOW_MS,
    MAX_LOGIN_FAILURES,
    LOGIN_BLOCK_MS,
  )
}

export async function clearLoginFailures(repository: AuthRepository, username: string, ipHash: string) {
  await repository.clearLoginFailures(username, ipHash)
}

export async function revokeAllSessions(repository: AuthRepository, userId: string) {
  await repository.revokeAllSessions(userId)
}

export async function findUser(repository: AuthRepository, username: string) {
  return repository.findUser(username)
}

export async function createSession(repository: AuthRepository, session: NewSession) {
  await repository.createSession(session)
}

export async function deleteSessionByTokenHash(repository: AuthRepository, tokenHash: string) {
  await repository.deleteSessionByTokenHash(tokenHash)
}
