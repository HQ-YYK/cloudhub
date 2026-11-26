import { classifyPlatformResponse } from '../utils/service-limits.ts'

export type AdminUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: 0 | 1
  must_change_password: 0 | 1
  created_at: string
  updated_at: string
}

export type StorageAccountStatus = 'active' | 'readonly' | 'reauth'

export type StorageAccount = {
  id: number
  googleEmail: string
  status: StorageAccountStatus
  quotaTotal: number | null
  quotaUsed: number | null
  quotaCheckedAt: string | null
  fileCount: number
  bytesStored: number
  createdAt: string
}

type AdminResponse = {
  users?: AdminUser[]
  user?: AdminUser
  accounts?: StorageAccount[]
  url?: string
  ok?: boolean
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

async function requestAdmin(path: string, init?: RequestInit): Promise<AdminResponse> {
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

  let payload: AdminResponse
  try {
    payload = await response.json() as AdminResponse
  } catch {
    const code = classifyPlatformResponse(response.status, response.headers.get('Content-Type')) ?? 'invalid_response'
    throw new AdminRequestError(response.status, code)
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

export async function listStorageAccounts(): Promise<StorageAccount[]> {
  const payload = await requestAdmin('/api/admin/storage')
  if (!Array.isArray(payload.accounts)) throw new AdminRequestError(500, 'invalid_response')
  return payload.accounts
}

export async function connectStorageAccount(): Promise<string> {
  const payload = await requestAdmin('/api/admin/storage/connect', { method: 'POST' })
  if (typeof payload.url !== 'string') throw new AdminRequestError(500, 'invalid_response')
  return payload.url
}

export async function setStorageAccountStatus(id: number, status: 'active' | 'readonly'): Promise<void> {
  await requestAdmin(`/api/admin/storage/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  })
}

export async function refreshStorageAccount(id: number): Promise<void> {
  await requestAdmin(`/api/admin/storage/${id}/refresh`, { method: 'POST' })
}

export async function removeStorageAccount(id: number): Promise<void> {
  await requestAdmin(`/api/admin/storage/${id}`, { method: 'DELETE' })
}
