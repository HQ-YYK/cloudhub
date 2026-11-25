import { CryptoError } from './encoding.ts'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_CODE_CHAR_COUNT = 52

const CROCKFORD_DIGITS: Record<string, number> = {}
for (let index = 0; index < CROCKFORD_ALPHABET.length; index += 1) {
  CROCKFORD_DIGITS[CROCKFORD_ALPHABET[index]] = index
}

function crockfordEncode(bytes: Uint8Array<ArrayBuffer>): string {
  let start = 0
  while (start < bytes.length && bytes[start] === 0) start += 1
  if (start === bytes.length) return CROCKFORD_ALPHABET[0].repeat(RECOVERY_CODE_CHAR_COUNT)

  let value: number[] = []
  for (let index = start; index < bytes.length; index += 1) value.push(bytes[index])

  const digits: number[] = []
  while (value.length > 0) {
    let remainder = 0
    const next: number[] = []
    for (const byte of value) {
      const current = remainder * 256 + byte
      next.push(Math.floor(current / 32))
      remainder = current % 32
    }
    digits.push(remainder)
    let nextStart = 0
    while (nextStart < next.length && next[nextStart] === 0) nextStart += 1
    value = next.slice(nextStart)
  }

  while (digits.length < RECOVERY_CODE_CHAR_COUNT) digits.push(0)
  digits.reverse()
  return digits.map((digit) => CROCKFORD_ALPHABET[digit]).join('')
}

function crockfordDecode(text: string): Uint8Array<ArrayBuffer> {
  const bytes: number[] = []
  for (const char of text) {
    const digit = CROCKFORD_DIGITS[char]
    if (digit === undefined) throw new CryptoError('invalid_recovery_code')
    let carry = digit
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      const current = bytes[index] * 32 + carry
      bytes[index] = current % 256
      carry = Math.floor(current / 256)
    }
    while (carry > 0) {
      bytes.unshift(carry % 256)
      carry = Math.floor(carry / 256)
    }
  }

  let start = 0
  while (start < bytes.length && bytes[start] === 0) start += 1
  const significant = bytes.slice(start)
  if (significant.length > 32) throw new CryptoError('invalid_recovery_code')

  const result = new Uint8Array(32)
  result.set(significant, 32 - significant.length)
  return result
}

export function generateRecoveryKey(): { bytes: Uint8Array<ArrayBuffer>; display: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const encoded = crockfordEncode(bytes)
  const display = encoded.match(/.{1,4}/gu)?.join('-') ?? ''
  return { bytes, display }
}

export function parseRecoveryCode(text: string): Uint8Array<ArrayBuffer> {
  let normalized = ''
  for (const char of text) {
    if (char === ' ' || char === '-') continue
    let upper = char.toUpperCase()
    if (upper === 'I' || upper === 'L') upper = '1'
    else if (upper === 'O') upper = '0'
    else if (upper === 'U') throw new CryptoError('invalid_recovery_code')
    normalized += upper
  }
  if (normalized.length !== RECOVERY_CODE_CHAR_COUNT) throw new CryptoError('invalid_recovery_code')
  return crockfordDecode(normalized)
}
