import { base64UrlDecode, base64UrlEncode, CryptoError, utf8Decode, utf8Encode } from './encoding.ts'
import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from './keys.ts'

export async function nameIndex(nameIndexKey: CryptoKey, parentId: string | null, name: string): Promise<string> {
  const normalized = name.normalize('NFC').trim()
  const lower = normalized.toLocaleLowerCase('en-US')
  const parent = parentId ?? 'root'
  const signature = await crypto.subtle.sign('HMAC', nameIndexKey, utf8Encode(`${parent}/${lower}`))
  return base64UrlEncode(new Uint8Array(signature))
}

async function sealJson(key: CryptoKey, aad: string, value: unknown): Promise<string> {
  return base64UrlEncode(await aesGcmEncrypt(key, aad, utf8Encode(JSON.stringify(value))))
}

async function openJson<T>(key: CryptoKey, aad: string, cipherB64: string): Promise<T> {
  const plaintext = await aesGcmDecrypt(key, aad, base64UrlDecode(cipherB64))
  try {
    return JSON.parse(utf8Decode(plaintext)) as T
  } catch {
    throw new CryptoError('decrypt_failed')
  }
}

export async function encryptFileMeta(
  fk: Uint8Array<ArrayBuffer>,
  fileId: string,
  meta: { name: string; mimeType: string | null },
): Promise<string> {
  return sealJson(await importAesGcmKey(fk), `cloudhub/v1/file-meta:${fileId}`, meta)
}

export async function decryptFileMeta(
  fk: Uint8Array<ArrayBuffer>,
  fileId: string,
  cipherB64: string,
): Promise<{ name: string; mimeType: string | null }> {
  return openJson<{ name: string; mimeType: string | null }>(await importAesGcmKey(fk), `cloudhub/v1/file-meta:${fileId}`, cipherB64)
}

export async function encryptFolderName(folderKey: CryptoKey, folderId: string, name: string): Promise<string> {
  return sealJson(folderKey, `cloudhub/v1/folder-name:${folderId}`, { name })
}

export async function decryptFolderName(folderKey: CryptoKey, folderId: string, cipherB64: string): Promise<{ name: string }> {
  return openJson<{ name: string }>(folderKey, `cloudhub/v1/folder-name:${folderId}`, cipherB64)
}
