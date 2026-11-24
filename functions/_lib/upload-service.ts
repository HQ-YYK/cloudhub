import { getAuthenticatedUser } from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'
import { BlobStoreError } from './blob-store.ts'
import { ensureDriveFolder } from './drive-folders.ts'
import {
  FileRepositoryConflictError,
  type FileRepository,
  type UploadRepository,
} from './file-repository.ts'
import {
  FileServiceError,
  normalizeFileName,
  publicFileRecord,
  validateFileId,
} from './file-service.ts'
import { clearAccessTokenCache } from './google-oauth.ts'
import { decryptSecret, encryptSecret } from './secret-box.ts'
import type { StorageRepository } from './storage-repository.ts'

export const CHUNK_SIZE = 32 * 1024 * 1024
export const CHUNK_ALIGNMENT = 256 * 1024
export const MAX_FILE_SIZE = 10 * 1024 ** 3

const SESSION_TTL_MS = 6 * 24 * 60 * 60 * 1000
const RESUME_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum'

export type UploadErrorCode =
  | 'unauthorized'
  | 'password_change_required'
  | 'invalid_request'
  | 'invalid_name'
  | 'invalid_size'
  | 'empty_file'
  | 'invalid_chunk'
  | 'not_found'
  | 'conflict'
  | 'offset_mismatch'
  | 'upload_expired'
  | 'size_mismatch'
  | 'storage_not_connected'
  | 'storage_not_configured'
  | 'storage_unavailable'

export class UploadServiceError extends Error {
  readonly code: UploadErrorCode
  readonly receivedBytes?: number

  constructor(code: UploadErrorCode, options?: { receivedBytes?: number; cause?: unknown }) {
    super(code, { cause: options?.cause })
    this.name = 'UploadServiceError'
    this.code = code
    if (options?.receivedBytes !== undefined) this.receivedBytes = options.receivedBytes
  }
}

export interface UploadDriveClient {
  createFolder(name: string, parentId: string): Promise<string>
  trash(id: string): Promise<void>
  authorizedFetch(input: string, init?: RequestInit): Promise<Response>
}

export type FixedLengthStreamFactory = (length: number) => TransformStream<Uint8Array, Uint8Array>

export interface UploadServiceDeps {
  authRepository: AuthRepository
  fileRepository: FileRepository
  uploadRepository: UploadRepository
  storageRepository: StorageRepository
  driveClient: UploadDriveClient
  encryptionKey: string
  fetchImpl: typeof fetch
  createFixedLengthStream: FixedLengthStreamFactory
  now?: () => Date
}

export interface CreateUploadBody {
  parentId?: unknown
  name?: unknown
  size?: unknown
  mimeType?: unknown
}

export interface UploadCreated {
  uploadId: string
  chunkSize: number
  receivedBytes: number
}

function parseRangeReceived(range: string | null): number | null {
  if (!range) return null
  const match = /bytes=0-(\d+)/u.exec(range)
  if (!match) return null
  const received = Number(match[1]) + 1
  return Number.isSafeInteger(received) ? received : null
}

export function createUploadService(deps: UploadServiceDeps) {
  const now = deps.now ?? (() => new Date())

  async function authenticated(request: Request) {
    const user = await getAuthenticatedUser(deps.authRepository, request)
    if (!user) throw new UploadServiceError('unauthorized')
    if (user.mustChangePassword) throw new UploadServiceError('password_change_required')
    return user
  }

  function storageError(error: unknown): UploadServiceError {
    if (error instanceof UploadServiceError) return error
    if (error instanceof BlobStoreError) {
      if (error.message === 'storage_not_connected') {
        return new UploadServiceError('storage_not_connected', { cause: error })
      }
      if (error.message === 'storage_not_configured') {
        return new UploadServiceError('storage_not_configured', { cause: error })
      }
    }
    return new UploadServiceError('storage_unavailable', { cause: error })
  }

  async function markFailed(ownerId: string, fileId: string, updatedAt: string) {
    try {
      await deps.uploadRepository.markFileFailed(ownerId, fileId, updatedAt)
    } catch {
      // Best-effort cleanup; the storage error we return matters more.
    }
  }

  async function create(request: Request, body: CreateUploadBody): Promise<UploadCreated> {
    const user = await authenticated(request)

    let name: string
    let nameKey: string
    try {
      const normalized = normalizeFileName(body.name)
      name = normalized.name
      nameKey = normalized.nameKey
    } catch (error) {
      if (error instanceof FileServiceError && error.code === 'invalid_name') {
        throw new UploadServiceError('invalid_name')
      }
      throw error
    }

    let parentId: string | null = null
    if (body.parentId !== undefined && body.parentId !== null) {
      if (typeof body.parentId !== 'string') throw new UploadServiceError('invalid_request')
      try {
        validateFileId(body.parentId)
      } catch {
        throw new UploadServiceError('not_found')
      }
      parentId = body.parentId
    }
    if (parentId !== null) {
      const parent = await deps.fileRepository.findDirectory(user.id, parentId)
      if (!parent) throw new UploadServiceError('not_found')
    }

    const size = body.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) {
      throw new UploadServiceError('invalid_size')
    }
    if (size === 0) throw new UploadServiceError('empty_file')
    if (size < 1 || size > MAX_FILE_SIZE) throw new UploadServiceError('invalid_size')

    let mimeType: string | null = null
    const rawMime = body.mimeType
    if (rawMime !== undefined && rawMime !== null) {
      const valid = typeof rawMime === 'string'
        && rawMime.length <= 255
        && /^[-\w.+]+\/[-\w.+]+$/u.test(rawMime)
      mimeType = valid ? rawMime : 'application/octet-stream'
    }

    const fileId = crypto.randomUUID()
    const createdAt = now().toISOString()

    try {
      await deps.fileRepository.createPendingFile({
        id: fileId,
        ownerId: user.id,
        parentId,
        name,
        nameKey,
        objectKey: null,
        sizeBytes: size,
        mimeType,
        createdAt,
        updatedAt: createdAt,
      })
    } catch (error) {
      if (error instanceof FileRepositoryConflictError) throw new UploadServiceError('conflict')
      throw error
    }

    let folderId: string
    try {
      folderId = await ensureDriveFolder(
        deps.driveClient,
        deps.storageRepository,
        deps.uploadRepository,
        user.id,
        parentId,
      )
    } catch (error) {
      await markFailed(user.id, fileId, createdAt)
      throw storageError(error)
    }

    let sessionUri: string
    try {
      const response = await deps.driveClient.authorizedFetch(RESUME_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': mimeType ?? 'application/octet-stream',
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ name, parents: [folderId] }),
      })
      if (!response.ok) throw new BlobStoreError('unavailable', 'google_drive_resume_create_failed')
      sessionUri = response.headers.get('Location') ?? ''
      if (!sessionUri) throw new BlobStoreError('unavailable', 'google_drive_resume_location_missing')
    } catch (error) {
      await markFailed(user.id, fileId, createdAt)
      throw storageError(error)
    }

    const encrypted = await encryptSecret(sessionUri, deps.encryptionKey)
    await deps.uploadRepository.createUploadSession({
      file_id: fileId,
      owner_id: user.id,
      session_uri_ciphertext: encrypted.ciphertext,
      session_uri_iv: encrypted.iv,
      total_bytes: size,
      received_bytes: 0,
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: new Date(now().getTime() + SESSION_TTL_MS).toISOString(),
    })

    return { uploadId: fileId, chunkSize: CHUNK_SIZE, receivedBytes: 0 }
  }

  async function loadSession(request: Request, fileId: string) {
    const user = await authenticated(request)
    try {
      validateFileId(fileId)
    } catch {
      throw new UploadServiceError('not_found')
    }
    const session = await deps.uploadRepository.findUploadSession(user.id, fileId)
    if (!session) throw new UploadServiceError('not_found')
    return { user, session }
  }

  async function putChunk(request: Request, fileId: string) {
    const { user, session } = await loadSession(request, fileId)

    if (new Date(session.expires_at).getTime() <= now().getTime()) {
      await markFailed(user.id, fileId, now().toISOString())
      throw new UploadServiceError('upload_expired')
    }

    const offsetValue = new URL(request.url).searchParams.get('offset')
    const offset = Number(offsetValue)
    if (offsetValue === null || !Number.isSafeInteger(offset) || offset < 0) {
      throw new UploadServiceError('invalid_chunk')
    }

    const contentLengthValue = request.headers.get('Content-Length')
    const contentLength = Number(contentLengthValue)
    if (
      contentLengthValue === null
      || !Number.isSafeInteger(contentLength)
      || contentLength <= 0
      || contentLength > CHUNK_SIZE
    ) {
      throw new UploadServiceError('invalid_chunk')
    }

    if (offset !== session.received_bytes) {
      throw new UploadServiceError('offset_mismatch', { receivedBytes: session.received_bytes })
    }

    const total = session.total_bytes
    const end = offset + contentLength
    if (end > total) throw new UploadServiceError('invalid_chunk')
    if (end < total && contentLength % CHUNK_ALIGNMENT !== 0) {
      throw new UploadServiceError('invalid_chunk')
    }

    const sessionUri = await decryptSecret(
      session.session_uri_ciphertext,
      session.session_uri_iv,
      deps.encryptionKey,
    )

    const body = request.body
      ? request.body.pipeThrough(deps.createFixedLengthStream(contentLength))
      : null

    let response: Response
    try {
      response = await deps.fetchImpl(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': String(contentLength),
          'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
        },
        body,
        redirect: 'manual',
      })
    } catch (error) {
      throw new UploadServiceError('storage_unavailable', { cause: error })
    }

    const updatedAt = now().toISOString()

    if (response.status === 308) {
      const received = parseRangeReceived(response.headers.get('Range'))
      if (received === null) throw new UploadServiceError('storage_unavailable')
      await deps.uploadRepository.updateUploadProgress(user.id, fileId, offset, received, updatedAt)
      return { receivedBytes: received, done: false }
    }

    if (response.status === 200 || response.status === 201) {
      let payload: { id?: unknown; size?: unknown; md5Checksum?: unknown }
      try {
        payload = await response.json() as typeof payload
      } catch {
        throw new UploadServiceError('storage_unavailable')
      }
      const driveId = typeof payload.id === 'string' ? payload.id : ''
      const driveSize = Number(payload.size)
      if (!driveId || !Number.isSafeInteger(driveSize) || driveSize !== total) {
        if (driveId) {
          try {
            await deps.driveClient.trash(driveId)
          } catch {
            // Best-effort cleanup of the oversized Drive object.
          }
        }
        await markFailed(user.id, fileId, updatedAt)
        throw new UploadServiceError('size_mismatch')
      }
      const md5 = typeof payload.md5Checksum === 'string' ? payload.md5Checksum : null
      const completed = await deps.uploadRepository.updateCompletedFile(
        user.id,
        fileId,
        driveId,
        md5,
        updatedAt,
      )
      if (!completed) throw new UploadServiceError('storage_unavailable')
      await deps.uploadRepository.deleteUploadSession(user.id, fileId)
      return { receivedBytes: total, done: true, item: publicFileRecord(completed) }
    }

    if (response.status === 404 || response.status === 410) {
      await markFailed(user.id, fileId, updatedAt)
      throw new UploadServiceError('upload_expired')
    }

    if (response.status === 401) {
      clearAccessTokenCache()
      throw new UploadServiceError('storage_unavailable')
    }

    throw new UploadServiceError('storage_unavailable')
  }

  async function getProgress(request: Request, fileId: string) {
    const { user, session } = await loadSession(request, fileId)
    const sessionUri = await decryptSecret(
      session.session_uri_ciphertext,
      session.session_uri_iv,
      deps.encryptionKey,
    )
    let response: Response
    try {
      response = await deps.fetchImpl(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': '0',
          'Content-Range': `bytes */${session.total_bytes}`,
        },
        redirect: 'manual',
      })
    } catch {
      return { receivedBytes: session.received_bytes, total: session.total_bytes, done: false }
    }

    if (response.status === 200 || response.status === 201) {
      return { receivedBytes: session.total_bytes, total: session.total_bytes, done: true }
    }
    if (response.status === 308) {
      const received = parseRangeReceived(response.headers.get('Range')) ?? session.received_bytes
      if (received !== session.received_bytes) {
        await deps.uploadRepository.updateUploadProgress(
          user.id,
          fileId,
          session.received_bytes,
          received,
          now().toISOString(),
        )
      }
      return { receivedBytes: received, total: session.total_bytes, done: false }
    }
    return { receivedBytes: session.received_bytes, total: session.total_bytes, done: false }
  }

  async function cancel(request: Request, fileId: string) {
    const { user, session } = await loadSession(request, fileId)
    const sessionUri = await decryptSecret(
      session.session_uri_ciphertext,
      session.session_uri_iv,
      deps.encryptionKey,
    )
    try {
      await deps.fetchImpl(sessionUri, { method: 'DELETE', redirect: 'manual' })
    } catch {
      // Best-effort: the session is deleted locally regardless.
    }
    await deps.uploadRepository.deleteUploadSession(user.id, fileId)
    await deps.uploadRepository.markFileFailed(user.id, fileId, now().toISOString())
    return { ok: true }
  }

  return { create, putChunk, getProgress, cancel }
}
