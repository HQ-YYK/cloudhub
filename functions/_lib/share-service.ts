import { getAuthenticatedUser } from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'
import { BlobStoreError, type BlobStore } from './blob-store.ts'
import { allowsInlineContentType, contentDisposition, INLINE_CONTENT_SECURITY_POLICY, normalizeMimeType, jsonResponse } from './http.ts'
import { contentRange, parseByteRange, unsatisfiedContentRange } from './range.ts'
import { decryptSecret, encryptSecret } from './secret-box.ts'
import type {
  ShareFileInfo,
  ShareRecord,
  ShareRepository,
  ShareWithFileRecord,
} from './share-repository.ts'

export const MAX_ACTIVE_SHARES_PER_FILE = 20
const SHARE_TOKEN_BYTES = 32
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const VALID_EXPIRES_DAYS = new Set([1, 7, 30])

export class ShareServiceError extends Error {
  readonly code:
    | 'unauthorized'
    | 'password_change_required'
    | 'invalid_expires'
    | 'not_found'
    | 'too_many_shares'
    | 'storage_unavailable'

  constructor(code: ShareServiceError['code'], options?: ErrorOptions) {
    super(code, options)
    this.name = 'ShareServiceError'
    this.code = code
  }
}

export interface ShareView {
  id: string
  fileId: string
  fileName: string
  enc: number
  encName: string
  wrappedKey: string | null
  url: string
  expiresAt: string | null
  revokedAt: string | null
  downloadCount: number
  createdAt: string
  active: boolean
}

export interface PublicShareMetadata {
  id: string
  enc: number
  name?: string
  encName?: string
  sizeBytes: number | null
  mimeType: string | null
  expiresAt: string | null
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isValidShareToken(token: string) {
  return SHARE_TOKEN_PATTERN.test(token)
}

function generateShareToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_BYTES)))
}

function resolveExpiry(rawExpiresInDays: unknown, now: string) {
  if (rawExpiresInDays === null) return null
  if (typeof rawExpiresInDays !== 'number' || !VALID_EXPIRES_DAYS.has(rawExpiresInDays)) {
    return undefined
  }
  return new Date(new Date(now).getTime() + rawExpiresInDays * 24 * 60 * 60 * 1000).toISOString()
}

function isFileShareable(file: ShareFileInfo) {
  return file.kind === 'file' && file.deleted_at === null && file.storage_status === 'ready'
}

function buildShareView(
  record: ShareRecord,
  file: {
    name: string
    deleted_at: string | null
    storage_status: string
    kind: string
    enc: number
    wrapped_key: string | null
  },
  token: string,
  origin: string,
  now: string,
): ShareView {
  return {
    id: record.id,
    fileId: record.file_id,
    fileName: file.name,
    enc: file.enc,
    encName: file.name,
    wrappedKey: file.wrapped_key,
    url: `${origin}/s/${token}`,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at,
    downloadCount: record.download_count,
    createdAt: record.created_at,
    active: record.revoked_at === null
      && (record.expires_at === null || record.expires_at > now)
      && file.deleted_at === null
      && file.storage_status === 'ready'
      && file.kind === 'file',
  }
}

async function decryptShareViews(
  records: ShareWithFileRecord[],
  encryptionKey: string,
  origin: string,
  now: string,
) {
  if (!encryptionKey) throw new ShareServiceError('storage_unavailable')
  const views: ShareView[] = []
  for (const record of records) {
    let token: string
    try {
      token = await decryptSecret(record.token_ciphertext, record.token_iv, encryptionKey)
    } catch {
      throw new ShareServiceError('storage_unavailable')
    }
    views.push(buildShareView(record, {
      name: record.file_name,
      deleted_at: record.file_deleted_at,
      storage_status: record.file_storage_status,
      kind: record.file_kind,
      enc: record.file_enc,
      wrapped_key: record.file_wrapped_key,
    }, token, origin, now))
  }
  return views
}

export async function createShare(
  authRepository: AuthRepository,
  shareRepository: ShareRepository,
  request: Request,
  fileId: string,
  rawExpiresInDays: unknown,
  encryptionKey: string,
  now = new Date().toISOString(),
) {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new ShareServiceError('unauthorized')
  if (user.mustChangePassword) throw new ShareServiceError('password_change_required')

  const expiresAt = resolveExpiry(rawExpiresInDays, now)
  if (expiresAt === undefined) throw new ShareServiceError('invalid_expires')

  const file = await shareRepository.findFileForShare(user.id, fileId)
  if (!file || !isFileShareable(file)) throw new ShareServiceError('not_found')

  const activeCount = await shareRepository.countActiveByFile(user.id, fileId, now)
  if (activeCount >= MAX_ACTIVE_SHARES_PER_FILE) throw new ShareServiceError('too_many_shares')

  if (!encryptionKey) throw new ShareServiceError('storage_unavailable')
  const token = generateShareToken()
  const tokenHash = await sha256Hex(token)
  const encrypted = await encryptSecret(token, encryptionKey)

  const record = await shareRepository.create({
    id: crypto.randomUUID(),
    ownerId: user.id,
    fileId,
    tokenHash,
    tokenCiphertext: encrypted.ciphertext,
    tokenIv: encrypted.iv,
    expiresAt,
    createdAt: now,
  })

  return buildShareView(record, {
    name: file.name,
    deleted_at: file.deleted_at,
    storage_status: file.storage_status,
    kind: file.kind,
    enc: file.enc,
    wrapped_key: file.wrapped_key,
  }, token, new URL(request.url).origin, now)
}

export async function listSharesByFile(
  authRepository: AuthRepository,
  shareRepository: ShareRepository,
  request: Request,
  fileId: string,
  encryptionKey: string,
  now = new Date().toISOString(),
) {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new ShareServiceError('unauthorized')
  if (user.mustChangePassword) throw new ShareServiceError('password_change_required')

  const file = await shareRepository.findFileForShare(user.id, fileId)
  if (!file) throw new ShareServiceError('not_found')

  const records = await shareRepository.listByFile(user.id, fileId, 50)
  return decryptShareViews(records, encryptionKey, new URL(request.url).origin, now)
}

export async function listSharesByOwner(
  authRepository: AuthRepository,
  shareRepository: ShareRepository,
  request: Request,
  encryptionKey: string,
  now = new Date().toISOString(),
) {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new ShareServiceError('unauthorized')
  if (user.mustChangePassword) throw new ShareServiceError('password_change_required')

  const records = await shareRepository.listByOwner(user.id, 200)
  return decryptShareViews(records, encryptionKey, new URL(request.url).origin, now)
}

export async function revokeShare(
  authRepository: AuthRepository,
  shareRepository: ShareRepository,
  request: Request,
  shareId: string,
  now = new Date().toISOString(),
) {
  const user = await getAuthenticatedUser(authRepository, request)
  if (!user) throw new ShareServiceError('unauthorized')
  if (user.mustChangePassword) throw new ShareServiceError('password_change_required')

  const share = await shareRepository.findById(shareId, user.id)
  if (!share) throw new ShareServiceError('not_found')

  await shareRepository.revoke(shareId, user.id, now)
}

export async function getPublicShareMetadata(
  shareRepository: ShareRepository,
  token: string,
  now = new Date().toISOString(),
): Promise<PublicShareMetadata> {
  if (!isValidShareToken(token)) throw new ShareServiceError('not_found')
  const record = await shareRepository.findActiveByTokenHash(await sha256Hex(token), now)
  if (!record) throw new ShareServiceError('not_found')
  if (record.file_enc === 1) {
    return {
      id: record.file_id,
      enc: 1,
      encName: record.file_name,
      sizeBytes: record.file_size_bytes,
      mimeType: record.file_mime_type,
      expiresAt: record.expires_at,
    }
  }
  return {
    id: record.file_id,
    enc: 0,
    name: record.file_name,
    sizeBytes: record.file_size_bytes,
    mimeType: record.file_mime_type,
    expiresAt: record.expires_at,
  }
}

export async function streamPublicShare(
  shareRepository: ShareRepository,
  createBlobStore: (accountId: number) => BlobStore,
  request: Request,
  token: string,
  now = new Date().toISOString(),
) {
  if (!isValidShareToken(token)) throw new ShareServiceError('not_found')
  const record = await shareRepository.findActiveByTokenHash(await sha256Hex(token), now)
  if (!record || !record.file_object_key) throw new ShareServiceError('not_found')

  const sizeBytes = record.file_size_bytes
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ShareServiceError('storage_unavailable')
  }

  const rangeResult = parseByteRange(request.headers.get('Range'), sizeBytes)
  if (rangeResult.kind === 'not-satisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': unsatisfiedContentRange(sizeBytes),
      },
    })
  }

  let blob
  try {
    blob = rangeResult.kind === 'range'
      ? await createBlobStore(record.file_storage_account_id ?? 1).get(record.file_object_key, { start: rangeResult.start, end: rangeResult.end })
      : await createBlobStore(record.file_storage_account_id ?? 1).get(record.file_object_key)
  } catch (error) {
    if (error instanceof BlobStoreError && error.code === 'not_found') {
      throw new ShareServiceError('not_found')
    }
    throw new ShareServiceError('storage_unavailable', { cause: error })
  }

  if (!Number.isSafeInteger(blob.sizeBytes) || blob.sizeBytes < 0) {
    throw new ShareServiceError('storage_unavailable')
  }

  if (!blob.range || blob.range.start === 0) {
    await shareRepository.incrementDownloadCount(record.id)
  }

  const encrypted = record.file_enc === 1
  const contentType = encrypted
    ? 'application/octet-stream'
    : (normalizeMimeType(blob.contentType ?? record.file_mime_type) ?? 'application/octet-stream')
  const inline = !encrypted && new URL(request.url).searchParams.get('inline') === '1'
  const renderInline = inline && allowsInlineContentType(contentType)
  const disposition = encrypted
    ? 'attachment'
    : (renderInline
      ? contentDisposition(record.file_name, 'inline')
      : contentDisposition(record.file_name))

  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': disposition,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  })
  if (renderInline) headers.set('Content-Security-Policy', INLINE_CONTENT_SECURITY_POLICY)
  if (blob.range) {
    headers.set('Content-Range', contentRange(blob.range.start, blob.range.end, blob.range.total))
    headers.set('Content-Length', String(blob.sizeBytes))
    return new Response(blob.body, { status: 206, headers })
  }
  headers.set('Content-Length', String(blob.sizeBytes))
  return new Response(blob.body, { status: 200, headers })
}

export function shareErrorResponse(error: unknown) {
  if (error instanceof ShareServiceError) {
    if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
    if (error.code === 'password_change_required') return jsonResponse({ error: 'password_change_required' }, 403)
    if (error.code === 'invalid_expires') return jsonResponse({ error: 'invalid_request' }, 400)
    if (error.code === 'not_found') return jsonResponse({ error: 'not_found' }, 404)
    if (error.code === 'too_many_shares') return jsonResponse({ error: 'too_many_shares' }, 409)
    if (error.code === 'storage_unavailable') return jsonResponse({ error: 'storage_unavailable' }, 503)
  }
  console.error('Share request failed')
  return jsonResponse({ error: 'storage_unavailable' }, 503)
}
