import { decryptFileMeta, encryptFileMeta, encryptFolderName } from '../crypto/index.ts'
import type { DriveItem } from '../api/files.ts'
import { fileKeyFor, folderKeyFor, nameKeyForName } from './session.ts'

export type RenamePayload = { encName: string; nameKey: string }

export async function buildRenamePayload(
  mk: Uint8Array<ArrayBuffer>,
  item: DriveItem,
  name: string,
): Promise<RenamePayload> {
  const nameKey = await nameKeyForName(mk, name)
  if (item.kind === 'directory') {
    const encName = await encryptFolderName(await folderKeyFor(mk), item.id, name)
    return { encName, nameKey }
  }
  // Legacy plaintext files have no file key and cannot be renamed (409 legacy_file).
  if (!item.wrappedKey) throw new Error('legacy_file')
  const fk = await fileKeyFor(mk, item.id, item.wrappedKey)
  const mimeType = (await decryptFileMeta(fk, item.id, item.name)).mimeType
  const encName = await encryptFileMeta(fk, item.id, { name, mimeType })
  return { encName, nameKey }
}

export async function buildCreateDirectoryPayload(
  mk: Uint8Array<ArrayBuffer>,
  name: string,
): Promise<{ id: string; encName: string; nameKey: string }> {
  const id = crypto.randomUUID()
  const encName = await encryptFolderName(await folderKeyFor(mk), id, name)
  const nameKey = await nameKeyForName(mk, name)
  return { id, encName, nameKey }
}
