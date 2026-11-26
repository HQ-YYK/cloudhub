import { decryptFileMeta, exportFileKey, importFileKey } from '../crypto/index.ts'
import type { ShareView } from '../api/shares.ts'
import { DECRYPT_FAILED_NAME, fileKeyFor } from './session.ts'

export function parseShareKeyHash(hash: string): Uint8Array<ArrayBuffer> | null {
  if (!hash.startsWith('#k=')) return null
  try {
    return importFileKey(hash.slice(3))
  } catch {
    return null
  }
}

export function buildShareUrl(origin: string, token: string, fk: Uint8Array<ArrayBuffer>): string {
  return `${origin}/s/${token}#k=${exportFileKey(fk)}`
}

export function shareUrlWithKey(baseUrl: string, fk: Uint8Array<ArrayBuffer>): string {
  return `${baseUrl}#k=${exportFileKey(fk)}`
}

export type ResolvedShare = {
  share: ShareView
  name: string
  fullUrl: string
  failed: boolean
}

export async function resolveShare(mk: Uint8Array<ArrayBuffer>, share: ShareView): Promise<ResolvedShare> {
  const nameField = share.encName || share.fileName || ''
  if (share.enc !== 1) {
    return { share, name: nameField, fullUrl: share.url, failed: false }
  }
  if (!share.wrappedKey) {
    return { share, name: DECRYPT_FAILED_NAME, fullUrl: share.url, failed: true }
  }
  try {
    const fk = await fileKeyFor(mk, share.fileId, share.wrappedKey)
    const meta = await decryptFileMeta(fk, share.fileId, nameField)
    return { share, name: meta.name, fullUrl: shareUrlWithKey(share.url, fk), failed: false }
  } catch {
    return { share, name: DECRYPT_FAILED_NAME, fullUrl: share.url, failed: true }
  }
}

export async function resolveShares(mk: Uint8Array<ArrayBuffer>, shares: ShareView[]): Promise<ResolvedShare[]> {
  return Promise.all(shares.map((share) => resolveShare(mk, share)))
}
