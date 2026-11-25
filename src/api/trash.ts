import { FilesRequestError, type DriveItem } from './files.ts'

export type TrashItem = DriveItem & {
  deleted_at: string
  expires_at: string
  parent_name: string | null
  item_count?: number
}

type TrashResponse = {
  items?: TrashItem[]
  item?: DriveItem
  purged?: number | boolean
  remaining?: number
  error?: string
}

async function requestTrash(path: string, init?: RequestInit): Promise<TrashResponse> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new FilesRequestError(0, 'network_error')
  }

  let payload: TrashResponse
  try {
    payload = await response.json() as TrashResponse
  } catch {
    throw new FilesRequestError(response.status, 'invalid_response')
  }
  if (!response.ok) throw new FilesRequestError(response.status, payload.error ?? 'request_failed')
  return payload
}

export async function listTrash(): Promise<TrashItem[]> {
  const payload = await requestTrash('/api/trash')
  if (!Array.isArray(payload.items)) throw new FilesRequestError(500, 'invalid_response')
  return payload.items
}

export async function restoreTrashItem(id: string): Promise<DriveItem> {
  const payload = await requestTrash(`/api/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  if (!payload.item) throw new FilesRequestError(500, 'invalid_response')
  return payload.item
}

export async function purgeTrashItem(
  id: string,
  onProgress?: (purged: number) => void,
): Promise<{ purged: number; remaining: number }> {
  let purged = 0
  let remaining = 0
  for (let round = 0; round < 200; round += 1) {
    const payload = await requestTrash(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (payload.purged === true) {
      onProgress?.(1)
      return { purged: 1, remaining: 0 }
    }
    if (typeof payload.purged !== 'number' || typeof payload.remaining !== 'number') {
      throw new FilesRequestError(500, 'invalid_response')
    }
    purged += payload.purged
    remaining = payload.remaining
    onProgress?.(purged)
    if (remaining <= 0 || payload.purged === 0) break
  }
  return { purged, remaining }
}

export async function emptyTrash(): Promise<{ purged: number; remaining: number }> {
  let purged = 0
  let remaining = 0
  for (let round = 0; round < 20; round += 1) {
    const payload = await requestTrash('/api/trash', { method: 'DELETE' })
    if (typeof payload.purged !== 'number' || typeof payload.remaining !== 'number') {
      throw new FilesRequestError(500, 'invalid_response')
    }
    purged += payload.purged
    remaining = payload.remaining
    if (remaining <= 0 || payload.purged === 0) break
  }
  return { purged, remaining }
}
