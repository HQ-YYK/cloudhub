export type DriveItem = {
  id: string
  parent_id: string | null
  kind: 'file' | 'directory'
  name: string
  size_bytes: number | null
  mime_type: string | null
  created_at: string
  updated_at: string
}

type FilesResponse = {
  items?: DriveItem[]
  error?: string
}

export class FilesRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'FilesRequestError'
    this.status = status
    this.code = code
  }
}

async function requestFiles(path: string, init?: RequestInit): Promise<FilesResponse> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new FilesRequestError(0, 'network_error')
  }

  let payload: FilesResponse
  try {
    payload = await response.json() as FilesResponse
  } catch {
    throw new FilesRequestError(response.status, 'invalid_response')
  }
  if (!response.ok) throw new FilesRequestError(response.status, payload.error ?? 'request_failed')
  return payload
}

export async function listFiles(parentId: string | null): Promise<DriveItem[]> {
  const path = parentId
    ? `/api/files?parent_id=${encodeURIComponent(parentId)}`
    : '/api/files'
  const payload = await requestFiles(path)
  if (!Array.isArray(payload.items)) throw new FilesRequestError(500, 'invalid_response')
  return payload.items
}

export async function createDirectory(name: string, parentId: string | null): Promise<DriveItem> {
  const payload = await requestFiles('/api/files/directories', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId }),
  })
  if (!payload.items && !('item' in payload)) {
    throw new FilesRequestError(500, 'invalid_response')
  }
  const item = (payload as FilesResponse & { item?: DriveItem }).item
  if (!item) throw new FilesRequestError(500, 'invalid_response')
  return item
}
