import { classifyPlatformResponse } from '../utils/service-limits.ts'
import { AuthRequestError, type AuthUser } from './auth.ts'

export type Passkey = {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  prf: boolean
}

export type PasskeyRegisterOptions = {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>
  excludeCredentials: Array<{ type: 'public-key'; id: string; transports?: AuthenticatorTransport[] }>
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' }
  attestation: 'none'
  timeout: number
}

export type PasskeyLoginOptions = {
  challenge: string
  rpId: string
  userVerification: 'required'
  timeout: number
}

export type PasskeyRegistrationBody = {
  challenge: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  publicKey: string
  publicKeyAlgorithm: number
  transports?: string[]
  name?: string
}

export type PasskeyLoginBody = {
  challenge: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle: string
}

async function requestPasskey<T = unknown>(path: string, init?: RequestInit): Promise<T | undefined> {
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

  if (response.status === 204) return undefined

  let payload: T & { error?: string }
  try {
    payload = await response.json() as T & { error?: string }
  } catch {
    const code = classifyPlatformResponse(response.status, response.headers.get('Content-Type')) ?? 'invalid_response'
    throw new AuthRequestError(response.status, code)
  }
  if (!response.ok) throw new AuthRequestError(response.status, payload.error ?? 'request_failed')
  return payload
}

function credentialPath(id: string): string {
  return `/api/auth/passkey/${encodeURIComponent(id)}`
}

export async function getPasskeyRegisterOptions(): Promise<PasskeyRegisterOptions> {
  const payload = await requestPasskey<PasskeyRegisterOptions>('/api/auth/passkey/register/options', { method: 'POST' })
  if (!payload || typeof payload.challenge !== 'string') throw new AuthRequestError(500, 'invalid_response')
  return payload
}

export async function verifyPasskeyRegistration(body: PasskeyRegistrationBody): Promise<{ passkey: Passkey }> {
  const payload = await requestPasskey<{ passkey?: Passkey }>('/api/auth/passkey/register/verify', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!payload || !payload.passkey) throw new AuthRequestError(500, 'invalid_response')
  return { passkey: payload.passkey }
}

export async function setPasskeyPrf(id: string, prfWrappedMasterKey: string): Promise<void> {
  await requestPasskey(`${credentialPath(id)}/prf`, {
    method: 'POST',
    body: JSON.stringify({ prfWrappedMasterKey }),
  })
}

export async function getPasskeyLoginOptions(): Promise<PasskeyLoginOptions> {
  const payload = await requestPasskey<PasskeyLoginOptions>('/api/auth/passkey/login/options', { method: 'POST' })
  if (!payload || typeof payload.challenge !== 'string') throw new AuthRequestError(500, 'invalid_response')
  return payload
}

export async function verifyPasskeyLogin(body: PasskeyLoginBody): Promise<{ user: AuthUser; prfWrappedMasterKey: string | null }> {
  const payload = await requestPasskey<{ user?: AuthUser; prfWrappedMasterKey?: string | null }>('/api/auth/passkey/login/verify', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!payload || !payload.user) throw new AuthRequestError(500, 'invalid_response')
  return { user: payload.user, prfWrappedMasterKey: payload.prfWrappedMasterKey ?? null }
}

export async function listPasskeys(): Promise<Passkey[]> {
  const payload = await requestPasskey<{ passkeys?: Passkey[] }>('/api/auth/passkey')
  if (!payload || !Array.isArray(payload.passkeys)) throw new AuthRequestError(500, 'invalid_response')
  return payload.passkeys
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  await requestPasskey(credentialPath(id), {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export async function deletePasskey(id: string): Promise<void> {
  await requestPasskey(credentialPath(id), { method: 'DELETE' })
}
