function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeKey(keyBase64: string) {
  const key = base64UrlDecode(keyBase64)
  if (key.byteLength !== 32) throw new Error('storage_key_invalid')
  return key
}

export async function encryptSecret(plaintext: string, keyBase64: string) {
  const keyBytes = decodeKey(keyBase64)
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoder = new TextEncoder()
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  )
  return {
    ciphertext: base64UrlEncode(new Uint8Array(encrypted)),
    iv: base64UrlEncode(iv),
  }
}

export async function decryptSecret(ciphertext: string, iv: string, keyBase64: string) {
  const keyBytes = decodeKey(keyBase64)
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(iv) },
    key,
    base64UrlDecode(ciphertext),
  )
  return new TextDecoder().decode(decrypted)
}
