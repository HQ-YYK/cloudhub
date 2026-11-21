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
  item?: DriveItem
  deleted?: boolean
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
        ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
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
  if (!payload.item) throw new FilesRequestError(500, 'invalid_response')
  return payload.item
}

function responseFileName(response: Response) {
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      // Fall back to the quoted filename when the header is malformed.
    }
  }
  return /filename="([^"]*)"/u.exec(disposition)?.[1] || 'download'
}

export async function downloadFile(fileId: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/files/${encodeURIComponent(fileId)}/download`, {
      credentials: 'same-origin',
    })
  } catch {
    throw new FilesRequestError(0, 'network_error')
  }
  if (!response.ok) {
    let payload: FilesResponse = {}
    try {
      payload = await response.json() as FilesResponse
    } catch {
      // The status still provides a safe error category.
    }
    throw new FilesRequestError(response.status, payload.error ?? 'request_failed')
  }

  const objectUrl = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = responseFileName(response)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

export async function deleteFile(fileId: string): Promise<void> {
  const payload = await requestFiles(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  })
  if (payload.deleted !== true) throw new FilesRequestError(500, 'invalid_response')
}
