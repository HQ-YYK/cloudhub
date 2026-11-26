import {
  CryptoError,
  decryptFileMeta,
  decryptFolderName,
  deriveFolderKey,
  deriveNameIndexKey,
  nameIndex,
  unwrapFileKey,
} from '../crypto/index.ts'
import type { DriveItem } from '../api/files.ts'
import { sanitizeDisplayName } from './names.ts'

let activeMk: Uint8Array<ArrayBuffer> | null = null
let folderKey: CryptoKey | null = null
let nameIndexKey: CryptoKey | null = null
const fileKeyCache = new Map<string, Uint8Array<ArrayBuffer>>()

export const DECRYPT_FAILED_NAME = '无法解密的项目'

export async function ensureDerivedKeys(mk: Uint8Array<ArrayBuffer>): Promise<void> {
  if (activeMk !== mk || !folderKey || !nameIndexKey) {
    folderKey = await deriveFolderKey(mk)
    nameIndexKey = await deriveNameIndexKey(mk)
    activeMk = mk
    fileKeyCache.clear()
  }
}

export function clearDerivedKeys(): void {
  activeMk = null
  folderKey = null
  nameIndexKey = null
  fileKeyCache.clear()
}

export async function folderKeyFor(mk: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  await ensureDerivedKeys(mk)
  return folderKey!
}

export async function nameKeyForName(mk: Uint8Array<ArrayBuffer>, name: string): Promise<string> {
  await ensureDerivedKeys(mk)
  return nameIndex(nameIndexKey!, null, name)
}

export async function fileKeyFor(mk: Uint8Array<ArrayBuffer>, id: string, wrappedKey: string): Promise<Uint8Array<ArrayBuffer>> {
  await ensureDerivedKeys(mk)
  const cached = fileKeyCache.get(id)
  if (cached) return cached
  const fk = await unwrapFileKey(wrappedKey, mk, id)
  fileKeyCache.set(id, fk)
  return fk
}

export type NameableItem = {
  id: string
  kind: 'file' | 'directory'
  enc: 0 | 1
  wrappedKey: string | null
  name: string
}

export type DisplayName = { name: string; status: 'plain' | 'encrypted' | 'failed' }

export async function resolveDisplayName(mk: Uint8Array<ArrayBuffer>, item: NameableItem): Promise<DisplayName> {
  if (item.enc !== 1) return { name: sanitizeDisplayName(item.name, item.kind), status: 'plain' }
  try {
    let name: string
    if (item.kind === 'directory') {
      name = (await decryptFolderName(await folderKeyFor(mk), item.id, item.name)).name
    } else {
      if (!item.wrappedKey) return { name: DECRYPT_FAILED_NAME, status: 'failed' }
      const fk = await fileKeyFor(mk, item.id, item.wrappedKey)
      name = (await decryptFileMeta(fk, item.id, item.name)).name
    }
    return { name: sanitizeDisplayName(name, item.kind), status: 'encrypted' }
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'decrypt_failed') {
      return { name: DECRYPT_FAILED_NAME, status: 'failed' }
    }
    throw error
  }
}

export type DisplayItem = {
  item: DriveItem
  name: string
  status: 'plain' | 'encrypted' | 'failed'
}

export async function resolveDriveItems(mk: Uint8Array<ArrayBuffer>, items: DriveItem[]): Promise<DisplayItem[]> {
  const resolved = await Promise.all(items.map(async (item) => {
    const display = await resolveDisplayName(mk, item)
    return { item, name: display.name, status: display.status }
  }))
  resolved.sort((a, b) => {
    if (a.item.kind !== b.item.kind) return a.item.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return resolved
}
