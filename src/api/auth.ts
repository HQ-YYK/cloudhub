export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  mustChangePassword: boolean
  totpEnabled?: boolean
  legacy: boolean
  keysReady: boolean
}

type AuthResponse = {
  user?: AuthUser
  error?: string
}

export type LoginResult =
  | { user: AuthUser }
  | { totpRequired: true; challenge: string }

export type TotpCredential = { code: string } | { recoveryCode: string }

export type LoginCredential =
  | { username: string; password: string }
  | { username: string; authKey: string }

export type PreloginResult =
  | { legacy: true }
  | { legacy: false; kdfSalt: string; kdfIterations: number }

export type KeysResponse = {
  legacy: boolean
  kdfSalt: string | null
  kdfIterations: number | null
  wrappedMasterKey: string | null
  recoveryWrappedKey: string | null
  error?: string
}

export type PasswordChangeBody = {
  currentAuthKey?: string
  currentPassword?: string
  newKdfSalt: string
  newAuthKey: string
  wrappedMasterKey: string
  recoveryWrappedKey?: string
}

export type ResetKeysBody = {
  currentAuthKey: string
  newKdfSalt: string
  newAuthKey: string
  wrappedMasterKey: string
  recoveryWrappedKey: string
}

export type DisableTotpCredential = { authKey: string } | { password: string }

export class AuthRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'AuthRequestError'
    this.status = status
    this.code = code
  }
}

async function requestAuth<T extends { error?: string } = AuthResponse>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new AuthRequestError(0, 'network_error')
  }

  let payload: T
  try {
    payload = await response.json() as T
  } catch {
    throw new AuthRequestError(response.status, 'invalid_response')
  }
  if (!response.ok) throw new AuthRequestError(response.status, payload.error ?? 'request_failed')
  return payload
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const payload = await requestAuth('/api/auth/me')
    return payload.user ?? null
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) return null
    throw error
  }
}

export async function prelogin(username: string): Promise<PreloginResult> {
  const payload = await requestAuth<{ legacy?: boolean; kdfSalt?: string | null; kdfIterations?: number | null; error?: string }>('/api/auth/prelogin', {
    method: 'POST',
    body: JSON.stringify({ username }),
  })
  if (payload.legacy === true) return { legacy: true }
  if (typeof payload.kdfSalt === 'string' && typeof payload.kdfIterations === 'number') {
    return { legacy: false, kdfSalt: payload.kdfSalt, kdfIterations: payload.kdfIterations }
  }
  throw new AuthRequestError(500, 'invalid_response')
}

export async function login(credential: LoginCredential): Promise<LoginResult> {
  const payload = await requestAuth<AuthResponse & { totpRequired?: boolean; challenge?: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(credential),
  })
  if (payload.totpRequired && typeof payload.challenge === 'string') {
    return { totpRequired: true, challenge: payload.challenge }
  }
  if (!payload.user) throw new AuthRequestError(500, 'invalid_response')
  return { user: { ...payload.user, totpEnabled: false } }
}

export async function verifyTotp(challenge: string, credential: TotpCredential): Promise<AuthUser> {
  const payload = await requestAuth('/api/auth/totp/verify', {
    method: 'POST',
    body: JSON.stringify({ challenge, ...credential }),
  })
  if (!payload.user) throw new AuthRequestError(500, 'invalid_response')
  return { ...payload.user, totpEnabled: true }
}

export async function setupTotp(): Promise<{ secret: string; otpauthUrl: string }> {
  const payload = await requestAuth<{ secret?: string; otpauthUrl?: string; error?: string }>('/api/auth/totp/setup', {
    method: 'POST',
  })
  if (typeof payload.secret !== 'string' || typeof payload.otpauthUrl !== 'string') {
    throw new AuthRequestError(500, 'invalid_response')
  }
  return { secret: payload.secret, otpauthUrl: payload.otpauthUrl }
}

export async function enableTotp(code: string): Promise<string[]> {
  const payload = await requestAuth<{ recoveryCodes?: string[]; error?: string }>('/api/auth/totp/enable', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  if (!Array.isArray(payload.recoveryCodes)) throw new AuthRequestError(500, 'invalid_response')
  return payload.recoveryCodes
}

export async function disableTotp(credential: DisableTotpCredential, code: string): Promise<void> {
  await requestAuth('/api/auth/totp/disable', {
    method: 'POST',
    body: JSON.stringify({ ...credential, code }),
  })
}

export async function logout(): Promise<void> {
  await requestAuth('/api/auth/logout', { method: 'POST' })
}

export async function getKeys(): Promise<KeysResponse> {
  const payload = await requestAuth<KeysResponse>('/api/auth/keys')
  if (typeof payload.legacy !== 'boolean') throw new AuthRequestError(500, 'invalid_response')
  return payload
}

export async function changePassword(body: PasswordChangeBody): Promise<void> {
  await requestAuth('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function regenerateRecoveryKey(body: { currentAuthKey: string; recoveryWrappedKey: string }): Promise<void> {
  await requestAuth('/api/auth/keys/recovery', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function resetKeys(body: ResetKeysBody): Promise<void> {
  await requestAuth('/api/auth/keys/reset', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
