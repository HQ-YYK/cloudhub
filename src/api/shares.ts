import { classifyPlatformResponse } from '../utils/service-limits.ts'

export type ShareView = {
  id: string
  fileId: string
  fileName: string
  enc: 0 | 1
  encName: string
  wrappedKey: string | null
  url: string
  expiresAt: string | null
  revokedAt: string | null
  downloadCount: number
  createdAt: string
  active: boolean
}

export type PublicShareMetadata = {
  enc: 0 | 1
  encName: string | null
  name: string | null
  sizeBytes: number | null
  mimeType: string | null
  expiresAt: string | null
  id: string | null
}

type ShareResponse = {
  share?: ShareView
  shares?: ShareView[]
  revoked?: boolean
  error?: string
  enc?: number
  encName?: string
  name?: string
  sizeBytes?: number | null
  mimeType?: string | null
  expiresAt?: string | null
  id?: string
}

export class SharesRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'SharesRequestError'
    this.status = status
    this.code = code
  }
}

async function requestShares(path: string, init?: RequestInit): Promise<ShareResponse> {
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
    throw new SharesRequestError(0, 'network_error')
  }

  let payload: ShareResponse
  try {
    payload = await response.json() as ShareResponse
  } catch {
    const code = classifyPlatformResponse(response.status, response.headers.get('Content-Type')) ?? 'invalid_response'
    throw new SharesRequestError(response.status, code)
  }
  if (!response.ok) throw new SharesRequestError(response.status, payload.error ?? 'request_failed')
  return payload
}

export async function createShare(fileId: string, expiresInDays: 1 | 7 | 30 | null): Promise<ShareView> {
  const payload = await requestShares(`/api/files/${encodeURIComponent(fileId)}/shares`, {
    method: 'POST',
    body: JSON.stringify({ expiresInDays }),
  })
  if (!payload.share) throw new SharesRequestError(500, 'invalid_response')
  return payload.share
}

export async function listSharesByFile(fileId: string): Promise<ShareView[]> {
  const payload = await requestShares(`/api/files/${encodeURIComponent(fileId)}/shares`)
  if (!Array.isArray(payload.shares)) throw new SharesRequestError(500, 'invalid_response')
  return payload.shares
}

export async function listShares(): Promise<ShareView[]> {
  const payload = await requestShares('/api/shares')
  if (!Array.isArray(payload.shares)) throw new SharesRequestError(500, 'invalid_response')
  return payload.shares
}

export async function revokeShare(shareId: string): Promise<void> {
  const payload = await requestShares(`/api/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' })
  if (payload.revoked !== true) throw new SharesRequestError(500, 'invalid_response')
}

export async function getPublicShare(token: string): Promise<PublicShareMetadata> {
  const payload = await requestShares(`/api/public/shares/${encodeURIComponent(token)}`)
  return {
    enc: payload.enc === 1 ? 1 : 0,
    encName: typeof payload.encName === 'string' ? payload.encName : null,
    name: typeof payload.name === 'string' ? payload.name : null,
    sizeBytes: payload.sizeBytes ?? null,
    mimeType: payload.mimeType ?? null,
    expiresAt: payload.expiresAt ?? null,
    id: typeof payload.id === 'string' ? payload.id : null,
  }
}

export async function fetchPublicShareRange(
  token: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  let response: Response
  try {
    response = await fetch(`/api/public/shares/${encodeURIComponent(token)}/download`, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      signal,
    })
  } catch {
    if (signal?.aborted) throw new SharesRequestError(0, 'aborted')
    throw new SharesRequestError(0, 'network_error')
  }
  if (!response.ok) {
    let payload: ShareResponse = {}
    try {
      payload = await response.json() as ShareResponse
    } catch {
      // The status still provides a safe error category.
    }
    throw new SharesRequestError(response.status, payload.error ?? 'request_failed')
  }
  if (!response.body) throw new SharesRequestError(response.status, 'invalid_response')
  return response.body
}
