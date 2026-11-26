import { classifyPlatformResponse } from '../utils/service-limits.ts'

export type DriveItem = {
  id: string
  parent_id: string | null
  kind: 'file' | 'directory'
  name: string
  size_bytes: number | null
  mime_type: string | null
  created_at: string
  updated_at: string
  enc: 0 | 1
  wrappedKey: string | null
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
    const code = classifyPlatformResponse(response.status, response.headers.get('Content-Type')) ?? 'invalid_response'
    throw new FilesRequestError(response.status, code)
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

export type CreateDirectoryInput = {
  id: string
  parentId: string | null
  encName: string
  nameKey: string
}

export async function createDirectory(input: CreateDirectoryInput): Promise<DriveItem> {
  const payload = await requestFiles('/api/files/directories', {
    method: 'POST',
    body: JSON.stringify({
      id: input.id,
      parent_id: input.parentId,
      encName: input.encName,
      nameKey: input.nameKey,
    }),
  })
  if (!payload.item) throw new FilesRequestError(500, 'invalid_response')
  return payload.item
}

export type RenameInput = { encName: string; nameKey: string }

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
  // Keep the object URL alive across the click so the browser never saves an
  // empty or truncated file before it has finished reading the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

export async function fetchFileRange(
  fileId: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  let response: Response
  try {
    response = await fetch(`/api/files/${encodeURIComponent(fileId)}/download`, {
      credentials: 'same-origin',
      headers: { Range: `bytes=${start}-${end - 1}` },
      signal,
    })
  } catch {
    if (signal?.aborted) throw new FilesRequestError(0, 'aborted')
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
  if (!response.body) throw new FilesRequestError(response.status, 'invalid_response')
  return response.body
}

export async function deleteFile(fileId: string): Promise<void> {
  const payload = await requestFiles(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  })
  if (payload.deleted !== true) throw new FilesRequestError(500, 'invalid_response')
}

export async function renameItem(id: string, input: RenameInput): Promise<DriveItem> {
  const payload = await requestFiles(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ encName: input.encName, nameKey: input.nameKey }),
  })
  if (!payload.item) throw new FilesRequestError(500, 'invalid_response')
  return payload.item
}

export async function moveItem(id: string, parentId: string | null): Promise<DriveItem> {
  const payload = await requestFiles(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId }),
  })
  if (!payload.item) throw new FilesRequestError(500, 'invalid_response')
  return payload.item
}
