export class CryptoError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'CryptoError'
    this.code = code
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(text)
}

export function utf8Decode(bytes: Uint8Array<ArrayBuffer>): string {
  return textDecoder.decode(bytes)
}

export function base64UrlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  let padded = text.replace(/-/gu, '+').replace(/_/gu, '/')
  while (padded.length % 4 !== 0) padded += '='
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new CryptoError('invalid_input')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
