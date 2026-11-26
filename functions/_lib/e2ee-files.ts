// Shared E2EE field and cipher-size validation for the files API.
// The server never encrypts or decrypts; it only checks that the fields the
// browser sends are base64url with the expected decoded byte lengths.

export const CIPHER_CHUNK_SIZE = 32 * 1024 * 1024
export const PLAIN_CHUNK_SIZE = CIPHER_CHUNK_SIZE - 28

const E2EE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
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

export function isValidE2eeId(value: unknown): value is string {
  return typeof value === 'string' && E2EE_ID_PATTERN.test(value)
}

export function isValidEncName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bytes = base64UrlDecode(value)
  return bytes !== null && bytes.length >= 29 && bytes.length <= 3000
}

export function isValidNameKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bytes = base64UrlDecode(value)
  return bytes !== null && bytes.length === 32
}

export function isValidWrappedKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bytes = base64UrlDecode(value)
  return bytes !== null && bytes.length === 60
}

// Mirrors plainSizeFromCipher in src/crypto/chunks.ts: a cipher size is valid
// when every non-final chunk is exactly CIPHER_CHUNK_SIZE and the final chunk
// is at least 28 bytes (and a multi-chunk file's last plaintext chunk is not
// empty).
export function isValidCipherSize(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 28) return false
  const chunkTotal = Math.ceil(value / CIPHER_CHUNK_SIZE)
  const lastCipherLength = value - (chunkTotal - 1) * CIPHER_CHUNK_SIZE
  if (lastCipherLength < 28) return false
  const lastPlainLength = lastCipherLength - 28
  if (lastPlainLength === 0 && chunkTotal > 1) return false
  return true
}

// Full column list for selecting a FileRecord. Some call sites historically
// selected a subset; the extra columns are harmless and keep FileRecord whole.
export const FILE_RECORD_COLUMNS = `
  id, owner_id, parent_id, kind, name, name_key, object_key, size_bytes,
  mime_type, created_at, updated_at, deleted_at, storage_status,
  drive_folder_id, md5, purged_at, storage_account_id, enc, wrapped_key
`
