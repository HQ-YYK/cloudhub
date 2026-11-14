import {
  MaxFileSizeExceededError,
  MaxHeaderSizeExceededError,
  MultipartParseError,
  parseMultipartStream,
} from '@mjackson/multipart-parser'
import { MAX_UPLOAD_SIZE_BYTES } from './file-upload-service.ts'

export const MAX_MULTIPART_BODY_BYTES = MAX_UPLOAD_SIZE_BYTES + 64 * 1024
export const MAX_MULTIPART_PARTS = 2
export const MAX_MULTIPART_HEADER_BYTES = 8 * 1024
export const MAX_MULTIPART_BOUNDARY_LENGTH = 70

type MultipartUploadErrorCode = 'invalid_request' | 'too_large'

export class MultipartUploadError extends Error {
  readonly code: MultipartUploadErrorCode

  constructor(code: MultipartUploadErrorCode, message: string = code) {
    super(message)
    this.name = 'MultipartUploadError'
    this.code = code
  }
}

export interface ParsedUploadMultipart {
  fileName: string
  mimeType: string | null
  body: Uint8Array
  parentId: string | null
}

function invalidRequest(message = 'invalid_multipart_request') {
  return new MultipartUploadError('invalid_request', message)
}

function parseContentLength(request: Request) {
  const value = request.headers.get('Content-Length')
  if (value === null) return null
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw invalidRequest('invalid_content_length')
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw invalidRequest('invalid_content_length')
  if (length > MAX_MULTIPART_BODY_BYTES) throw new MultipartUploadError('too_large')
  return length
}

function extractBoundary(request: Request) {
  const contentType = request.headers.get('Content-Type')
  if (contentType === null) throw invalidRequest('invalid_content_type')

  const separator = contentType.indexOf(';')
  const mediaType = (separator < 0 ? contentType : contentType.slice(0, separator)).trim().toLowerCase()
  if (mediaType !== 'multipart/form-data' || separator < 0) {
    throw invalidRequest('invalid_content_type')
  }

  const parameters = contentType.slice(separator + 1)
  const matches = [...parameters.matchAll(
    /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;]*?))\s*(?=;|$)/giu,
  )]
  if (matches.length !== 1) throw invalidRequest('invalid_boundary')

  const boundary = matches[0][1] ?? matches[0][2] ?? ''
  if (
    boundary.length === 0
    || boundary.length > MAX_MULTIPART_BOUNDARY_LENGTH
    || boundary.startsWith(' ')
    || boundary.endsWith(' ')
    || !/^[0-9A-Za-z'()+_,./:=? -]+$/u.test(boundary)
  ) {
    throw invalidRequest('invalid_boundary')
  }
  return boundary
}

export function createLimitedBody(body: ReadableStream<Uint8Array>, declaredLength: number | null) {
  const reader = body.getReader()
  let total = 0
  let released = false
  let cancelled = false

  async function release() {
    if (!released) {
      released = true
      reader.releaseLock()
    }
  }

  async function cancel(reason?: unknown) {
    if (released) return
    if (!cancelled) {
      cancelled = true
      try {
        await reader.cancel(reason)
      } finally {
        await release()
      }
    } else {
      await release()
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          await release()
          if (declaredLength !== null && declaredLength !== total) {
            controller.error(invalidRequest('content_length_mismatch'))
            return
          }
          controller.close()
          return
        }

        total += result.value.byteLength
        if (declaredLength !== null && total > declaredLength) {
          await cancel()
          controller.error(invalidRequest('content_length_mismatch'))
          return
        }
        if (total > MAX_MULTIPART_BODY_BYTES) {
          await cancel()
          controller.error(new MultipartUploadError('too_large'))
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        await release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await cancel(reason)
    },
  })

  return { stream, cancel }
}

export async function parseUploadMultipart(request: Request): Promise<ParsedUploadMultipart> {
  const declaredLength = parseContentLength(request)
  const boundary = extractBoundary(request)
  if (!request.body) throw invalidRequest('missing_body')

  const limited = createLimitedBody(request.body, declaredLength)
  let completed = false
  let fileName: string | null = null
  let mimeType: string | null = null
  let fileBody: Uint8Array | null = null
  let parentId: string | null = null
  let partCount = 0

  try {
    for await (const part of parseMultipartStream(limited.stream, {
      boundary,
      maxHeaderSize: MAX_MULTIPART_HEADER_BYTES,
      maxFileSize: MAX_UPLOAD_SIZE_BYTES,
    })) {
      partCount += 1
      if (partCount > MAX_MULTIPART_PARTS) throw invalidRequest('too_many_parts')

      const name = part.name
      if (name !== 'file' && name !== 'parent_id') {
        throw invalidRequest('unknown_field')
      }

      if (name === 'file') {
        if (fileBody !== null || part.filename === undefined) {
          throw invalidRequest('invalid_file_field')
        }
        fileName = part.filename
        mimeType = part.mediaType ?? null
        fileBody = part.bytes
        continue
      }

      if (parentId !== null || part.filename !== undefined) {
        throw invalidRequest('invalid_parent_field')
      }
      parentId = part.text
    }
    completed = true
  } catch (error) {
    if (error instanceof MultipartUploadError) throw error
    if (error instanceof MaxFileSizeExceededError) {
      throw new MultipartUploadError('too_large')
    }
    if (error instanceof MaxHeaderSizeExceededError || error instanceof MultipartParseError) {
      throw invalidRequest()
    }
    throw invalidRequest()
  } finally {
    if (!completed) await limited.cancel()
  }

  if (fileBody === null || fileName === null) throw invalidRequest('missing_file')
  return { fileName, mimeType, body: fileBody, parentId }
}
