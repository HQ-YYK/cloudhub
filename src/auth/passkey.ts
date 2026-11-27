import type { AuthUser } from '../api/auth.ts'
import {
  getPasskeyLoginOptions,
  getPasskeyRegisterOptions,
  setPasskeyPrf,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
  type PasskeyLoginOptions,
  type PasskeyRegisterOptions,
} from '../api/passkeys.ts'
import { base64UrlDecode, base64UrlEncode, CryptoError } from '../crypto/index.ts'
import { utf8Encode } from '../crypto/encoding.ts'
import { aesGcmDecrypt, aesGcmEncrypt } from '../crypto/keys.ts'

const PRF_SALT_INPUT = 'cloudhub/v1/prf-salt'
const PRF_WRAP_INFO = 'cloudhub/v1/prf-wrap'

type PrfOutput = { enabled?: boolean; results?: { first?: ArrayBuffer } }

function bytesFrom(arrayBuffer: ArrayBuffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(arrayBuffer)
}

function prfAad(userId: string, credentialId: string): string {
  return `cloudhub/v1/prf:${userId}:${credentialId}`
}

function prfResult(credential: PublicKeyCredential): PrfOutput | undefined {
  return (credential.getClientExtensionResults() as unknown as { prf?: PrfOutput }).prf
}

function credentialError(error: unknown, isRegistration: boolean): Error {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new Error('已取消或超时。', { cause: error instanceof Error ? error : undefined })
  }
  if (isRegistration && name === 'InvalidStateError') {
    return new Error('这个认证器已经添加过了。', { cause: error instanceof Error ? error : undefined })
  }
  return error instanceof Error ? error : new Error('认证器操作失败。')
}

// Fixed salt used for every PRF evaluation. It must stay stable so the same
// authenticator derives the same secret across registration and login.
export async function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return bytesFrom(await crypto.subtle.digest('SHA-256', utf8Encode(PRF_SALT_INPUT)))
}

// Derive a non-exportable AES-GCM wrapping key from a 32-byte PRF output.
export async function prfWrapKey(prfOutput: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const inputKeyMaterial = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: utf8Encode(PRF_WRAP_INFO) },
    inputKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function wrapMasterKeyWithPrf(
  mk: Uint8Array<ArrayBuffer>,
  prfOutput: Uint8Array<ArrayBuffer>,
  userId: string,
  credentialId: string,
): Promise<string> {
  const wrapKey = await prfWrapKey(prfOutput)
  return base64UrlEncode(await aesGcmEncrypt(wrapKey, prfAad(userId, credentialId), mk))
}

export async function unwrapMasterKeyWithPrf(
  wrappedB64: string,
  prfOutput: Uint8Array<ArrayBuffer>,
  userId: string,
  credentialId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const wrapKey = await prfWrapKey(prfOutput)
  const mk = await aesGcmDecrypt(wrapKey, prfAad(userId, credentialId), base64UrlDecode(wrappedB64))
  if (mk.length !== 32) throw new CryptoError('decrypt_failed')
  return mk
}

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window
    && typeof navigator !== 'undefined' && 'credentials' in navigator
}

export function toPublicKeyCredentialCreationOptions(
  options: PasskeyRegisterOptions,
  salt: Uint8Array<ArrayBuffer>,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64UrlDecode(options.challenge),
    rp: options.rp,
    user: {
      id: base64UrlDecode(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    excludeCredentials: options.excludeCredentials.map((credential) => ({
      type: credential.type,
      id: base64UrlDecode(credential.id),
      ...(credential.transports ? { transports: credential.transports } : {}),
    })),
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation,
    timeout: options.timeout,
    extensions: { prf: { eval: { first: salt } } },
  }
}

export function toPublicKeyCredentialRequestOptions(
  options: PasskeyLoginOptions,
  salt: Uint8Array<ArrayBuffer>,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlDecode(options.challenge),
    rpId: options.rpId,
    userVerification: options.userVerification,
    timeout: options.timeout,
    allowCredentials: [],
    extensions: { prf: { eval: { first: salt } } },
  }
}

async function wrapAndStorePrf(
  mk: Uint8Array<ArrayBuffer>,
  prfOutput: ArrayBuffer,
  userId: string,
  credentialId: string,
): Promise<boolean> {
  try {
    const prfWrappedMasterKey = await wrapMasterKeyWithPrf(mk, bytesFrom(prfOutput), userId, credentialId)
    await setPasskeyPrf(credentialId, prfWrappedMasterKey)
    return true
  } catch {
    return false
  }
}

async function registerPrf(
  credential: PublicKeyCredential,
  mk: Uint8Array<ArrayBuffer>,
  userId: string,
  credentialId: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const first = prfResult(credential)?.results?.first
  if (first) return wrapAndStorePrf(mk, first, userId, credentialId)

  if (prfResult(credential)?.enabled !== true) return false

  // Some authenticators only expose PRF on a subsequent get() that targets the
  // freshly created credential. This assertion is discarded (never verified).
  try {
    const loginOptions = await getPasskeyLoginOptions()
    const requestOptions = toPublicKeyCredentialRequestOptions(loginOptions, salt)
    requestOptions.allowCredentials = [{ type: 'public-key', id: base64UrlDecode(credentialId) }]
    const assertion = (await navigator.credentials.get({ publicKey: requestOptions })) as PublicKeyCredential
    const retryFirst = prfResult(assertion)?.results?.first
    if (!retryFirst) return false
    return wrapAndStorePrf(mk, retryFirst, userId, credentialId)
  } catch {
    return false
  }
}

export async function registerPasskey(
  mk: Uint8Array<ArrayBuffer>,
  name: string,
  userId: string,
): Promise<{ prf: boolean }> {
  const salt = await prfSalt()
  const options = await getPasskeyRegisterOptions()
  const creationOptions = toPublicKeyCredentialCreationOptions(options, salt)

  let credential: PublicKeyCredential
  try {
    credential = (await navigator.credentials.create({ publicKey: creationOptions })) as PublicKeyCredential
  } catch (error) {
    throw credentialError(error, true)
  }
  if (!credential) throw new Error('认证器未返回凭据。')

  const response = credential.response as AuthenticatorAttestationResponse
  const publicKey = response.getPublicKey()
  if (!publicKey) throw new Error('此认证器不受支持。')

  const credentialId = base64UrlEncode(bytesFrom(credential.rawId))
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined

  await verifyPasskeyRegistration({
    challenge: options.challenge,
    credentialId,
    clientDataJSON: base64UrlEncode(bytesFrom(response.clientDataJSON)),
    authenticatorData: base64UrlEncode(bytesFrom(response.getAuthenticatorData())),
    publicKey: base64UrlEncode(bytesFrom(publicKey)),
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
    transports,
    name,
  })

  // PRF setup failure must not roll back the registration; the passkey still
  // works for login, it just cannot unlock the workspace.
  const prf = await registerPrf(credential, mk, userId, credentialId, salt)
  return { prf }
}

export async function loginWithPasskey(): Promise<{ user: AuthUser; mk: Uint8Array<ArrayBuffer> | null }> {
  const salt = await prfSalt()
  const options = await getPasskeyLoginOptions()
  const requestOptions = toPublicKeyCredentialRequestOptions(options, salt)

  let assertion: PublicKeyCredential
  try {
    assertion = (await navigator.credentials.get({ publicKey: requestOptions })) as PublicKeyCredential
  } catch (error) {
    throw credentialError(error, false)
  }
  if (!assertion) throw new Error('认证器未返回凭据。')

  const response = assertion.response as AuthenticatorAssertionResponse
  if (!response.userHandle) throw new Error('Passkey 验证失败，请改用密码登录。')

  const credentialId = base64UrlEncode(bytesFrom(assertion.rawId))
  const result = await verifyPasskeyLogin({
    challenge: options.challenge,
    credentialId,
    clientDataJSON: base64UrlEncode(bytesFrom(response.clientDataJSON)),
    authenticatorData: base64UrlEncode(bytesFrom(response.authenticatorData)),
    signature: base64UrlEncode(bytesFrom(response.signature)),
    userHandle: base64UrlEncode(bytesFrom(response.userHandle)),
  })

  let mk: Uint8Array<ArrayBuffer> | null = null
  const first = prfResult(assertion)?.results?.first
  if (result.prfWrappedMasterKey && first) {
    try {
      mk = await unwrapMasterKeyWithPrf(result.prfWrappedMasterKey, bytesFrom(first), result.user.id, credentialId)
    } catch {
      mk = null
    }
  }

  return { user: result.user, mk }
}
