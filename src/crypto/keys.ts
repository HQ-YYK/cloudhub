import { base64UrlDecode, base64UrlEncode, CryptoError, utf8Encode } from './encoding.ts'

export async function importAesGcmKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function hkdfDerive(inputKeyMaterial: Uint8Array<ArrayBuffer>, info: string, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', inputKeyMaterial, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

async function derivePasswordSecret(password: string, kdfSalt: string, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', utf8Encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlDecode(kdfSalt), iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function deriveFromPassword(password: string, kdfSalt: string, iterations = 600000) {
  const passwordSecret = await derivePasswordSecret(password, kdfSalt, iterations)
  const wrapKey = await importAesGcmKey(await hkdfDerive(passwordSecret, 'cloudhub/v1/wrap', 32))
  const authKey = base64UrlEncode(await hkdfDerive(passwordSecret, 'cloudhub/v1/auth', 32))
  return { wrapKey, authKey }
}

export function generateMasterKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32))
}

export function generateKdfSalt(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
}

export function generateFileKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32))
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  aad: string,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8Encode(aad), tagLength: 128 },
    key,
    plaintext,
  )
  const result = new Uint8Array(12 + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), 12)
  return result
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  aad: string,
  sealed: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < 28) throw new CryptoError('decrypt_failed')
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: utf8Encode(aad), tagLength: 128 },
      key,
      sealed.slice(12),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new CryptoError('decrypt_failed')
  }
}

export async function wrapMasterKey(mk: Uint8Array<ArrayBuffer>, wrapKey: CryptoKey, userId: string): Promise<string> {
  return base64UrlEncode(await aesGcmEncrypt(wrapKey, `cloudhub/v1/mk:${userId}`, mk))
}

export async function unwrapMasterKey(
  wrappedB64: string,
  wrapKey: CryptoKey,
  userId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const mk = await aesGcmDecrypt(wrapKey, `cloudhub/v1/mk:${userId}`, base64UrlDecode(wrappedB64))
  if (mk.length !== 32) throw new CryptoError('decrypt_failed')
  return mk
}

export async function wrapFileKey(fk: Uint8Array<ArrayBuffer>, mk: Uint8Array<ArrayBuffer>, fileId: string): Promise<string> {
  return base64UrlEncode(await aesGcmEncrypt(await importAesGcmKey(mk), `cloudhub/v1/fk:${fileId}`, fk))
}

export async function unwrapFileKey(
  wrappedB64: string,
  mk: Uint8Array<ArrayBuffer>,
  fileId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmDecrypt(await importAesGcmKey(mk), `cloudhub/v1/fk:${fileId}`, base64UrlDecode(wrappedB64))
}

export function exportFileKey(fk: Uint8Array<ArrayBuffer>): string {
  return base64UrlEncode(fk)
}

export function importFileKey(text: string): Uint8Array<ArrayBuffer> {
  const bytes = base64UrlDecode(text)
  if (bytes.length !== 32) throw new CryptoError('invalid_input')
  return bytes
}

export async function deriveFolderKey(mk: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return importAesGcmKey(await hkdfDerive(mk, 'cloudhub/v1/folder-name', 32))
}

export async function deriveNameIndexKey(mk: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const bytes = await hkdfDerive(mk, 'cloudhub/v1/name-index', 32)
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export async function recoveryWrapKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return importAesGcmKey(await hkdfDerive(bytes, 'cloudhub/v1/recovery', 32))
}
