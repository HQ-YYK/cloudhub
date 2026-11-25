import type { D1Database } from '@cloudflare/workers-types'

export const KDF_ITERATIONS = 600000

const encoder = new TextEncoder()

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function isBase64Url(value: string) {
  return /^[A-Za-z0-9_-]+$/u.test(value)
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!isBase64Url(value)) return null
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodesToLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false
  const bytes = base64UrlDecode(value)
  return bytes !== null && bytes.length === length
}

export function isValidKdfSalt(value: unknown): value is string {
  return decodesToLength(value, 16)
}

export function isValidAuthKey(value: unknown): value is string {
  return decodesToLength(value, 32)
}

export function isValidWrappedKey(value: unknown): value is string {
  return decodesToLength(value, 60)
}

async function deriveFakeSaltKey(encryptionKeyBase64: string) {
  const keyBytes = base64UrlDecode(encryptionKeyBase64)
  if (!keyBytes || keyBytes.length !== 32) throw new Error('storage_key_invalid')
  const hkdfKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('cloudhub/v1/fake-salt') },
    hkdfKey,
    256,
  )
  return crypto.subtle.importKey('raw', new Uint8Array(bits), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export async function deriveFakeSalt(encryptionKeyBase64: string, username: string) {
  const key = await deriveFakeSaltKey(encryptionKeyBase64)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(username.toLowerCase()))
  return base64UrlEncode(new Uint8Array(signature).slice(0, 16))
}

export interface UpdateKeysInput {
  passwordHash: string
  passwordSalt: string
  passwordIterations: number
  kdfSalt: string
  kdfIterations: number
  wrappedMasterKey: string
  recoveryWrappedKey: string | null
  mustChangePassword: number
  keysUpdatedAt: string
  updatedAt: string
}

export interface KeysRepository {
  updateKeys(userId: string, input: UpdateKeysInput): Promise<void>
  updateRecoveryKey(userId: string, recoveryWrappedKey: string, keysUpdatedAt: string, updatedAt: string): Promise<void>
}

export function createD1KeysRepository(db: D1Database): KeysRepository {
  return {
    async updateKeys(userId, input) {
      await db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, password_iterations = ?,
            kdf_salt = ?, kdf_iterations = ?,
            wrapped_master_key = ?, recovery_wrapped_key = ?,
            keys_updated_at = ?,
            must_change_password = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        input.passwordHash,
        input.passwordSalt,
        input.passwordIterations,
        input.kdfSalt,
        input.kdfIterations,
        input.wrappedMasterKey,
        input.recoveryWrappedKey,
        input.keysUpdatedAt,
        input.mustChangePassword,
        input.updatedAt,
        userId,
      ).run()
    },

    async updateRecoveryKey(userId, recoveryWrappedKey, keysUpdatedAt, updatedAt) {
      await db.prepare(`
        UPDATE users
        SET recovery_wrapped_key = ?, keys_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(recoveryWrappedKey, keysUpdatedAt, updatedAt, userId).run()
    },
  }
}
