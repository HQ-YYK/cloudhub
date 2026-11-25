import { constantTimeEqual, sha256 } from './auth.ts'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const MAX_CHALLENGE_FAILURES = 5
export const RECOVERY_CODE_COUNT = 10

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const RECOVERY_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const encoder = new TextEncoder()

export function base32Encode(bytes: Uint8Array) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(value: string) {
  const output: number[] = []
  let bits = 0
  let buffer = 0
  for (const character of value.toUpperCase().replace(/=+$/u, '')) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('invalid_base32')
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output.push((buffer >>> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  return new Uint8Array(output)
}

async function hmacSha1(key: Uint8Array, message: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, message)
  return new Uint8Array(signature)
}

function stepCounter(step: number) {
  const counter = new Uint8Array(8)
  let remaining = step
  for (let index = counter.length - 1; index >= 0; index -= 1) {
    counter[index] = remaining & 0xff
    remaining = Math.floor(remaining / 256)
  }
  return counter
}

function dynamicTruncate(digest: Uint8Array) {
  const offset = digest[digest.length - 1] & 0x0f
  return (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  )
}

export async function totpCode(secret: Uint8Array, step: number, digits = TOTP_DIGITS) {
  const digest = await hmacSha1(secret, stepCounter(step))
  return String(dynamicTruncate(digest) % 10 ** digits).padStart(digits, '0')
}

export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)))
}

export async function verifyTotpCode(
  secretBase32: string,
  code: string,
  lastStep: number | null,
  nowMs = Date.now(),
) {
  const secret = base32Decode(secretBase32)
  const currentStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS)
  for (const step of [currentStep - 1, currentStep, currentStep + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    const candidate = await totpCode(secret, step, TOTP_DIGITS)
    if (constantTimeEqual(encoder.encode(candidate), encoder.encode(code))) return step
  }
  return null
}

export function otpauthUrl(username: string, secretBase32: string) {
  const label = encodeURIComponent(`CloudHub:${username}`)
  const secret = encodeURIComponent(secretBase32)
  const issuer = encodeURIComponent('CloudHub')
  const algorithm = encodeURIComponent('SHA1')
  const digits = encodeURIComponent(String(TOTP_DIGITS))
  const period = encodeURIComponent(String(TOTP_PERIOD_SECONDS))
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=${algorithm}&digits=${digits}&period=${period}`
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function createChallengeToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let code = ''
  for (const byte of bytes) code += RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes: Array<{ code: string, codeHash: string }> = []
  for (let index = 0; index < count; index += 1) {
    const code = generateRecoveryCode()
    codes.push({ code, codeHash: await sha256(code) })
  }
  return codes
}
