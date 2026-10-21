import { getAuthenticatedUser } from './auth.ts'
import type { AuthRepository } from './auth-repository.ts'
import {
  BlobStoreError,
  type BlobStore,
} from './blob-store.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
} from './file-repository.ts'
import {
  FileServiceError,
  normalizeFileName,
  validateFileId,
} from './file-service.ts'

export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024

export interface FileUploadInput {
  name: unknown
  parentId: string | null
  mimeType?: string | null
}

export class FileUploadError extends FileServiceError {
  constructor(
    code: 'invalid_mime' | 'too_large' | 'invalid_body' | 'upload_failed' | 'cleanup_failed',
    options?: ErrorOptions,
  ) {
    super(code, options)
    this.name = 'FileUploadError'
  }
}

function validateMimeType(value: string | null | undefined) {
  if (value === null || value === undefined) return null
  const mimeType = value.trim()
  const hasControlCharacter = [...mimeType].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  if (
    mimeType.length === 0
    || mimeType.length > 255
    || hasControlCharacter
    || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;\s*[^;\r\n]+)*$/u.test(mimeType)
  ) {
    throw new FileUploadError('invalid_mime')
  }
  return mimeType
}

async function readRequestBody(request: Request) {
  const contentLength = request.headers.get('Content-Length')
  let declaredSize: number | null = null
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
      throw new FileUploadError('invalid_body')
    }
    declaredSize = Number(contentLength)
    if (!Number.isSafeInteger(declaredSize)) throw new FileUploadError('invalid_body')
    if (declaredSize > MAX_UPLOAD_SIZE_BYTES) throw new FileUploadError('too_large')
  }

  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_UPLOAD_SIZE_BYTES) {
        await reader.cancel()
        throw new FileUploadError('too_large')
      }
      chunks.push(result.value.slice())
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (declaredSize !== null && declaredSize !== body.byteLength) {
    throw new FileUploadError('invalid_body')
  }
  return body
}

async function markFailed(
  fileRepository: FileRepository,
  ownerId: string,
  fileId: string,
  updatedAt: string,
) {
  return fileRepository.updateFileStorageStatus(ownerId, fileId, 'pending', 'failed', updatedAt)
}

async function cleanUploadedObject(blobStore: BlobStore, objectKey: string) {
  try {
    await blobStore.delete(objectKey)
  } catch (error) {
    if (error instanceof BlobStoreError && error.code === 'not_found') return
    throw error
  }
}

export async function uploadFile(
  authRepository: AuthRepository,
  fileRepository: FileRepository,
  blobStore: BlobStore,
  request: Request,
  input: FileUploadInput,
  now = new Date(),
) {
  const user = await getAuthenticatedUser(authRepository, request, now)
  if (!user) throw new FileServiceError('unauthorized')

  const { name, nameKey } = normalizeFileName(input.name)
  const parentId = input.parentId
  if (parentId !== null) {
    validateFileId(parentId)
    const parent = await fileRepository.findDirectory(user.id, parentId)
    if (!parent) throw new FileServiceError('invalid_parent')
  }
  const mimeType = validateMimeType(input.mimeType)
  const body = await readRequestBody(request)
  const fileId = crypto.randomUUID()
  const objectKey = `objects/${fileId}/content`
  const createdAt = now.toISOString()

  let pending: FileRecord
  try {
    pending = await fileRepository.createPendingFile({
      id: fileId,
      ownerId: user.id,
      parentId,
      name,
      nameKey,
      objectKey,
      sizeBytes: body.byteLength,
      mimeType,
      createdAt,
      updatedAt: createdAt,
    })
  } catch (error) {
    if (error instanceof FileRepositoryConflictError) throw new FileServiceError('conflict')
    throw error
  }

  let putAttempted = false
  try {
    putAttempted = true
    const head = await blobStore.put({
      objectKey,
      body,
      contentType: mimeType ?? undefined,
      overwrite: false,
    })
    if (head.objectKey !== objectKey || head.sizeBytes !== body.byteLength) {
      throw new FileUploadError('upload_failed')
    }

    const ready = await fileRepository.updateFileStorageStatus(
      user.id,
      pending.id,
      'pending',
      'ready',
      new Date().toISOString(),
    )
    if (!ready) throw new FileUploadError('upload_failed')
    return ready
  } catch (error) {
    let stateError: unknown
    let failedMarked = false
    try {
      failedMarked = Boolean(await markFailed(
        fileRepository,
        user.id,
        pending.id,
        new Date().toISOString(),
      ))
    } catch (failure) {
      stateError = failure
    }

    let cleanupError: unknown
    if (putAttempted && failedMarked) {
      try {
        await cleanUploadedObject(blobStore, objectKey)
      } catch (failure) {
        cleanupError = failure
      }
    }

    if (stateError) throw stateError
    if (!failedMarked) throw new FileUploadError('upload_failed', { cause: error })
    if (cleanupError) throw new FileUploadError('cleanup_failed', { cause: cleanupError })
    if (error instanceof FileUploadError) throw error
    if (error instanceof BlobStoreError) throw new FileUploadError('upload_failed', { cause: error })
    throw error
  }
}
