import type { SessionUser } from '../../_lib/auth-repository.ts'
import type {
  NewPasskeyCredential,
  NewWebauthnChallenge,
  PasskeyCredential,
  PasskeyRepository,
  WebauthnChallenge,
} from '../../_lib/passkey-repository.ts'
import { base64UrlToBytes, bytesToBase64Url } from '../../_lib/webauthn.ts'
import {
  adminId,
  adminSessionUser,
  authRepository,
  originRequest,
  sessionUser,
  storedUser,
  userId,
  verifyEnv,
} from './totp.fixtures.ts'
import { createListPasskeysHandler } from './passkey/index.ts'
import { createPasskeyIdHandler } from './passkey/[id].ts'
import { createPasskeyPrfHandler } from './passkey/[id]/prf.ts'
import { createPasskeyLoginOptionsHandler } from './passkey/login/options.ts'
import { createPasskeyLoginVerifyHandler } from './passkey/login/verify.ts'
import { createPasskeyRegisterOptionsHandler } from './passkey/register/options.ts'
import { createPasskeyRegisterVerifyHandler } from './passkey/register/verify.ts'

export {
  adminId,
  adminSessionUser,
  authRepository,
  originRequest,
  sessionUser,
  storedUser,
  userId,
  verifyEnv,
}

const encoder = new TextEncoder()

export const wrappedMasterKey = Buffer.alloc(60, 3).toString('base64url')
export const prfWrappedKey = Buffer.alloc(60, 4).toString('base64url')

export const passkeySessionUser: SessionUser = { ...sessionUser, wrapped_master_key: wrappedMasterKey }

export function bytesToB64(bytes: Uint8Array): string {
  return bytesToBase64Url(bytes)
}

export function b64ToBytes(value: string): Uint8Array {
  return base64UrlToBytes(value) ?? new Uint8Array(0)
}

export function credentialIdBytes(label: string): Uint8Array {
  return encoder.encode(label)
}

export async function generateEs256KeyPair(): Promise<{ publicKeySpki: string, privateKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer
  return { publicKeySpki: bytesToBase64Url(new Uint8Array(spki)), privateKey: keyPair.privateKey }
}

export async function generateRs256KeyPair(): Promise<{ publicKeySpki: string, privateKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer
  return { publicKeySpki: bytesToBase64Url(new Uint8Array(spki)), privateKey: keyPair.privateKey }
}

function derInteger(value: Uint8Array): Uint8Array {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start += 1
  const trimmed = value.slice(start)
  const needsZero = (trimmed[0] & 0x80) !== 0
  const content = needsZero ? new Uint8Array([0x00, ...trimmed]) : trimmed
  const out = new Uint8Array(2 + content.length)
  out[0] = 0x02
  out[1] = content.length
  out.set(content, 2)
  return out
}

export function rawToDerSignature(raw: Uint8Array): Uint8Array {
  const rEncoded = derInteger(raw.slice(0, 32))
  const sEncoded = derInteger(raw.slice(32, 64))
  const bodyLength = rEncoded.length + sEncoded.length
  const out = new Uint8Array(2 + bodyLength)
  out[0] = 0x30
  out[1] = bodyLength
  out.set(rEncoded, 2)
  out.set(sEncoded, 2 + rEncoded.length)
  return out
}

export async function signEs256(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data))
  return bytesToBase64Url(rawToDerSignature(raw))
}

export async function signRs256(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, data))
  return bytesToBase64Url(signature)
}

export function buildClientDataJSON(options: {
  type: string
  challenge: string
  origin: string
  crossOrigin?: boolean
}): string {
  const payload = JSON.stringify({
    type: options.type,
    challenge: options.challenge,
    origin: options.origin,
    ...(options.crossOrigin === true ? { crossOrigin: true } : {}),
  })
  return bytesToBase64Url(encoder.encode(payload))
}

export async function buildAuthenticatorData(options: {
  rpId: string
  flags: number
  signCount: number
  credentialId?: Uint8Array
}): Promise<string> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(options.rpId)))
  const parts: Uint8Array[] = [rpIdHash, new Uint8Array([options.flags])]
  const signCountBytes = new Uint8Array(4)
  signCountBytes[0] = (options.signCount >>> 24) & 0xff
  signCountBytes[1] = (options.signCount >>> 16) & 0xff
  signCountBytes[2] = (options.signCount >>> 8) & 0xff
  signCountBytes[3] = options.signCount & 0xff
  parts.push(signCountBytes)
  if (options.credentialId) {
    const aaguid = new Uint8Array(16)
    const lengthBytes = new Uint8Array(2)
    lengthBytes[0] = (options.credentialId.length >>> 8) & 0xff
    lengthBytes[1] = options.credentialId.length & 0xff
    parts.push(aaguid, lengthBytes, options.credentialId)
  }
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return bytesToBase64Url(out)
}

export async function buildSignedData(authenticatorData: string, clientDataJSON: string): Promise<Uint8Array> {
  const authData = base64UrlToBytes(authenticatorData) ?? new Uint8Array(0)
  const clientData = base64UrlToBytes(clientDataJSON) ?? new Uint8Array(0)
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
  const signedData = new Uint8Array(authData.length + clientDataHash.length)
  signedData.set(authData, 0)
  signedData.set(clientDataHash, authData.length)
  return signedData
}

export function passkeyCredential(overrides: Partial<PasskeyCredential> = {}): PasskeyCredential {
  return {
    id: '',
    user_id: userId,
    public_key: '',
    algorithm: -7,
    sign_count: 0,
    name: 'Passkey',
    transports: null,
    prf_wrapped_master_key: null,
    created_at: '2030-01-01T00:00:00.000Z',
    last_used_at: null,
    ...overrides,
  }
}

export interface MockLoginUser {
  username: string
  role: 'admin' | 'user'
  disabled: number
  must_change_password: number
  wrapped_master_key: string | null
}

export function passkeyRepository(options: {
  credentials?: PasskeyCredential[]
  loginUser?: MockLoginUser
} = {}) {
  const credentials = new Map((options.credentials ?? []).map((credential) => [credential.id, credential]))
  const challenges = new Map<string, WebauthnChallenge>()
  const created: NewPasskeyCredential[] = []
  const createdChallenges: NewWebauthnChallenge[] = []
  const consumed: string[] = []
  const prfSet: Array<[string, string]> = []
  const prfCleared: string[] = []
  const deletedPasskeys: string[] = []
  const deletedUsers: string[] = []
  const renamed: Array<[string, string]> = []
  const usage: Array<[string, number, string]> = []

  const repository: PasskeyRepository = {
    async listPasskeys(userId) {
      return [...credentials.values()]
        .filter((credential) => credential.user_id === userId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((credential) => ({
          id: credential.id,
          name: credential.name,
          created_at: credential.created_at,
          last_used_at: credential.last_used_at,
          transports: credential.transports,
          prf: credential.prf_wrapped_master_key ? 1 : 0,
        }))
    },
    async countPasskeys(userId) {
      return [...credentials.values()].filter((credential) => credential.user_id === userId).length
    },
    async findPasskeyById(id) {
      return credentials.get(id) ?? null
    },
    async findPasskeyForLogin(id) {
      const credential = credentials.get(id)
      if (!credential || !options.loginUser) return null
      return {
        id: credential.id,
        user_id: credential.user_id,
        public_key: credential.public_key,
        algorithm: credential.algorithm,
        sign_count: credential.sign_count,
        prf_wrapped_master_key: credential.prf_wrapped_master_key,
        username: options.loginUser.username,
        role: options.loginUser.role,
        disabled: options.loginUser.disabled,
        must_change_password: options.loginUser.must_change_password,
        wrapped_master_key: options.loginUser.wrapped_master_key,
      }
    },
    async createPasskey(input) {
      created.push(input)
      credentials.set(input.id, {
        id: input.id,
        user_id: input.userId,
        public_key: input.publicKey,
        algorithm: input.algorithm,
        sign_count: input.signCount,
        name: input.name,
        transports: input.transports,
        prf_wrapped_master_key: null,
        created_at: input.createdAt,
        last_used_at: null,
      })
      return true
    },
    async updatePasskeyName(userId, id, name) {
      const credential = credentials.get(id)
      if (!credential || credential.user_id !== userId) return false
      renamed.push([id, name])
      credentials.set(id, { ...credential, name })
      return true
    },
    async setPrfWrappedKey(userId, id, prfWrappedKey) {
      const credential = credentials.get(id)
      if (!credential || credential.user_id !== userId || credential.prf_wrapped_master_key !== null) return false
      prfSet.push([id, prfWrappedKey])
      credentials.set(id, { ...credential, prf_wrapped_master_key: prfWrappedKey })
      return true
    },
    async deletePasskey(userId, id) {
      const credential = credentials.get(id)
      if (!credential || credential.user_id !== userId) return false
      deletedPasskeys.push(id)
      credentials.delete(id)
      return true
    },
    async deletePasskeysByUser(userId) {
      deletedUsers.push(userId)
      for (const [id, credential] of credentials) {
        if (credential.user_id === userId) credentials.delete(id)
      }
    },
    async clearPrfWrappedKeys(userId) {
      prfCleared.push(userId)
      for (const [id, credential] of credentials) {
        if (credential.user_id === userId && credential.prf_wrapped_master_key !== null) {
          credentials.set(id, { ...credential, prf_wrapped_master_key: null })
        }
      }
    },
    async updatePasskeyUsage(id, signCount, lastUsedAt) {
      const credential = credentials.get(id)
      if (!credential) return
      usage.push([id, signCount, lastUsedAt])
      credentials.set(id, { ...credential, sign_count: signCount, last_used_at: lastUsedAt })
    },
    async createWebauthnChallenge(input) {
      createdChallenges.push(input)
      challenges.set(input.challengeHash, {
        id: input.id,
        user_id: input.userId,
        purpose: input.purpose,
        challenge_hash: input.challengeHash,
        ip_hash: input.ipHash,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      })
    },
    async findWebauthnChallenge(challengeHash, now) {
      const challenge = challenges.get(challengeHash)
      return challenge && challenge.expires_at > now ? challenge : null
    },
    async consumeWebauthnChallenge(challengeHash, now) {
      consumed.push(challengeHash)
      const challenge = challenges.get(challengeHash)
      if (!challenge || challenge.expires_at <= now) return false
      challenges.delete(challengeHash)
      return true
    },
  }

  return {
    repository,
    credentials,
    challenges,
    created,
    createdChallenges,
    consumed,
    prfSet,
    prfCleared,
    deletedPasskeys,
    deletedUsers,
    renamed,
    usage,
    get loginUser() { return options.loginUser },
  }
}

export function makePasskeyHandlers(
  auth: ReturnType<typeof authRepository>,
  passkeys: ReturnType<typeof passkeyRepository>,
) {
  return {
    registerOptions: createPasskeyRegisterOptionsHandler({
      createAuthRepository: () => auth.repository,
      createPasskeyRepository: () => passkeys.repository,
    }),
    registerVerify: createPasskeyRegisterVerifyHandler({
      createAuthRepository: () => auth.repository,
      createPasskeyRepository: () => passkeys.repository,
    }),
    loginOptions: createPasskeyLoginOptionsHandler({
      createPasskeyRepository: () => passkeys.repository,
    }),
    loginVerify: createPasskeyLoginVerifyHandler({
      createAuthRepository: () => auth.repository,
      createPasskeyRepository: () => passkeys.repository,
    }),
    list: createListPasskeysHandler({
      createAuthRepository: () => auth.repository,
      createPasskeyRepository: () => passkeys.repository,
    }),
    id: createPasskeyIdHandler({
      createAuthRepository: () => auth.repository,
      createPasskeyRepository: () => passkeys.repository,
    }),
    prf: createPasskeyPrfHandler({
      createAuthRepository: () => auth.repository,
      createPasskeyRepository: () => passkeys.repository,
    }),
  }
}
