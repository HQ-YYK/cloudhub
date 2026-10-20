export type AuthUser = {
  id: string
  username: string
}

type AuthResponse = {
  user?: AuthUser
  error?: string
}

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

async function requestAuth(path: string, init?: RequestInit): Promise<AuthResponse> {
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

  let payload: AuthResponse
  try {
    payload = await response.json() as AuthResponse
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

export async function login(username: string, password: string): Promise<AuthUser> {
  const payload = await requestAuth('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (!payload.user) throw new AuthRequestError(500, 'invalid_response')
  return payload.user
}

export async function logout(): Promise<void> {
  await requestAuth('/api/auth/logout', { method: 'POST' })
}
