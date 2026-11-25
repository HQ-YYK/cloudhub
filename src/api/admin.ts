export type AdminUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: 0 | 1
  must_change_password: 0 | 1
  created_at: string
  updated_at: string
}

type AdminUsersResponse = {
  users?: AdminUser[]
  user?: AdminUser
  error?: string
}

export class AdminRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'AdminRequestError'
    this.status = status
    this.code = code
  }
}

async function requestAdmin(path: string, init?: RequestInit): Promise<AdminUsersResponse> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new AdminRequestError(0, 'network_error')
  }

  let payload: AdminUsersResponse
  try {
    payload = await response.json() as AdminUsersResponse
  } catch {
    throw new AdminRequestError(response.status, 'invalid_response')
  }
  if (!response.ok) throw new AdminRequestError(response.status, payload.error ?? 'request_failed')
  return payload
}

export async function listUsers(): Promise<AdminUser[]> {
  const payload = await requestAdmin('/api/admin/users')
  if (!Array.isArray(payload.users)) throw new AdminRequestError(500, 'invalid_response')
  return payload.users
}

export async function createUser(username: string, kdfSalt: string, authKey: string): Promise<AdminUser> {
  const payload = await requestAdmin('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, kdfSalt, authKey }),
  })
  if (!payload.user) throw new AdminRequestError(500, 'invalid_response')
  return payload.user
}

export async function setUserDisabled(id: string, disabled: boolean): Promise<AdminUser> {
  const payload = await requestAdmin(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled }),
  })
  if (!payload.user) throw new AdminRequestError(500, 'invalid_response')
  return payload.user
}

export async function resetUserPassword(id: string, kdfSalt: string, authKey: string): Promise<AdminUser> {
  const payload = await requestAdmin(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    body: JSON.stringify({ kdfSalt, authKey }),
  })
  if (!payload.user) throw new AdminRequestError(500, 'invalid_response')
  return payload.user
}

export async function resetUserTotp(id: string): Promise<void> {
  await requestAdmin(`/api/admin/users/${encodeURIComponent(id)}/totp/reset`, { method: 'POST' })
}
