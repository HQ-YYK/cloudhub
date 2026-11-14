import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_MULTIPART_BODY_BYTES,
  MAX_MULTIPART_BOUNDARY_LENGTH,
  MAX_MULTIPART_HEADER_BYTES,
  MultipartUploadError,
  createLimitedBody,
  parseUploadMultipart,
} from './multipart-upload-parser.ts'
import { MAX_UPLOAD_SIZE_BYTES } from './file-upload-service.ts'

const boundary = 'CloudHubBoundary'
const encoder = new TextEncoder()

interface PartInput {
  name: string
  body: Uint8Array | string
  filename?: string
  contentType?: string
}

function bytes(value: Uint8Array | string) {
  return typeof value === 'string' ? encoder.encode(value) : value
}

function join(chunks: Uint8Array[]) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function multipart(parts: PartInput[], ending = true, boundaryValue = boundary) {
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    const headers = [
      `--${boundaryValue}\r\n`,
      `Content-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n`,
      ...(part.contentType === undefined ? [] : [`Content-Type: ${part.contentType}\r\n`]),
      '\r\n',
    ]
    chunks.push(...headers.map((header) => encoder.encode(header)))
    chunks.push(bytes(part.body), encoder.encode('\r\n'))
  }
  if (ending) chunks.push(encoder.encode(`--${boundaryValue}--\r\n`))
  return join(chunks)
}

function request(
  body: Uint8Array,
  options: {
    chunks?: Uint8Array[]
    contentLength?: string
    contentType?: string
    onCancel?: () => void
  } = {},
) {
  let index = 0
  const chunks = options.chunks ?? [body]
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    },
    cancel() {
      options.onCancel?.()
    },
  })
  const headers = new Headers({
    'Content-Type': options.contentType ?? `multipart/form-data; boundary=${boundary}`,
  })
  if (options.contentLength !== undefined) headers.set('Content-Length', options.contentLength)
  return new Request('https://cloudhub.test/api/files/upload', {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

function assertError(promise: Promise<unknown>, code: 'invalid_request' | 'too_large') {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof MultipartUploadError && error.code === code,
  )
}

test('parses a file, optional parent, and an empty file', async () => {
  const body = multipart([
    { name: 'parent_id', body: '11111111-1111-4111-8111-111111111111' },
    { name: 'file', filename: 'hello.txt', contentType: 'text/plain', body: 'hello' },
  ])
  const parsed = await parseUploadMultipart(request(body))
  assert.equal(parsed.fileName, 'hello.txt')
  assert.equal(parsed.mimeType, 'text/plain')
  assert.equal(parsed.parentId, '11111111-1111-4111-8111-111111111111')
  assert.deepEqual(parsed.body, encoder.encode('hello'))

  const empty = await parseUploadMultipart(request(multipart([
    { name: 'file', filename: 'empty.txt', body: '' },
  ])))
  assert.equal(empty.body.byteLength, 0)
})

test('handles boundaries and headers split across chunks', async () => {
  const body = multipart([{ name: 'file', filename: 'split.txt', body: 'split body' }])
  const chunks = [body.slice(0, 5), body.slice(5, 17), body.slice(17)]
  const parsed = await parseUploadMultipart(request(body, { chunks }))
  assert.equal(new TextDecoder().decode(parsed.body), 'split body')
})

test('rejects missing or truncated multipart endings', async () => {
  await assertError(
    parseUploadMultipart(request(multipart([{ name: 'file', filename: 'x', body: 'x' }], false))),
    'invalid_request',
  )
})

test('rejects invalid content types and boundaries', async () => {
  const body = multipart([{ name: 'file', filename: 'x', body: 'x' }])
  await assertError(parseUploadMultipart(request(body, { contentType: 'application/octet-stream' })), 'invalid_request')
  await assertError(parseUploadMultipart(request(body, { contentType: 'multipart/form-data' })), 'invalid_request')
  await assertError(parseUploadMultipart(request(body, {
    contentType: `multipart/form-data; boundary=${'x'.repeat(MAX_MULTIPART_BOUNDARY_LENGTH + 1)}`,
  })), 'invalid_request')
})

test('rejects oversized part headers and files', async () => {
  const largeHeader = multipart([{
    name: 'file',
    filename: 'x',
    body: 'x',
    contentType: `text/plain; ${'x'.repeat(MAX_MULTIPART_HEADER_BYTES)}`,
  }])
  await assertError(parseUploadMultipart(request(largeHeader)), 'invalid_request')

  const largeFile = multipart([{
    name: 'file',
    filename: 'large.bin',
    body: new Uint8Array(MAX_UPLOAD_SIZE_BYTES + 1),
  }])
  await assertError(parseUploadMultipart(request(largeFile)), 'too_large')
})

test('rejects oversized multipart bodies and cancels the source stream', async () => {
  const body = multipart([
    { name: 'file', filename: 'large.bin', body: new Uint8Array(MAX_UPLOAD_SIZE_BYTES - 1) },
    { name: 'parent_id', body: 'x'.repeat(70 * 1024) },
  ])
  assert.ok(body.byteLength > MAX_MULTIPART_BODY_BYTES)
  await assertError(
    parseUploadMultipart(request(body, {
      chunks: [body.slice(0, 1024 * 1024), body.slice(1024 * 1024)],
    })),
    'too_large',
  )
})

test('cancels the underlying reader when the counting stream exceeds its limit', async () => {
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_MULTIPART_BODY_BYTES + 1))
    },
    cancel() {
      cancelled = true
    },
  })
  const limited = createLimitedBody(source, null)
  await assert.rejects(() => limited.stream.getReader().read(), MultipartUploadError)
  assert.equal(cancelled, true)
})

test('rejects declared oversized bodies before reading', async () => {
  const uploadRequest = new Request('https://cloudhub.test/api/files/upload', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(MAX_MULTIPART_BODY_BYTES + 1),
    },
  })
  await assertError(parseUploadMultipart(uploadRequest), 'too_large')
})

test('rejects length mismatches and invalid declared lengths', async () => {
  const body = multipart([{ name: 'file', filename: 'x', body: 'actual' }])
  await assertError(
    parseUploadMultipart(request(body, { contentLength: String(body.byteLength - 1) })),
    'invalid_request',
  )
  await assertError(
    parseUploadMultipart(request(body, { contentLength: String(body.byteLength + 1) })),
    'invalid_request',
  )
  await assertError(parseUploadMultipart(request(body, { contentLength: '-1' })), 'invalid_request')
  await assertError(parseUploadMultipart(request(body, { contentLength: '9007199254740992' })), 'invalid_request')
})

test('rejects duplicate, unknown, and excessive parts', async () => {
  await assertError(parseUploadMultipart(request(multipart([
    { name: 'file', filename: 'one', body: '1' },
    { name: 'file', filename: 'two', body: '2' },
  ]))), 'invalid_request')
  await assertError(parseUploadMultipart(request(multipart([
    { name: 'parent_id', body: 'one' },
    { name: 'parent_id', body: 'two' },
  ]))), 'invalid_request')
  await assertError(parseUploadMultipart(request(multipart([
    { name: 'file', filename: 'one', body: '1' },
    { name: 'parent_id', body: 'two' },
    { name: 'extra', body: 'three' },
  ]))), 'invalid_request')
  await assertError(parseUploadMultipart(request(multipart([
    { name: 'extra', body: 'x' },
  ]))), 'invalid_request')
})

test('requires a file part and rejects malformed parent fields', async () => {
  await assertError(parseUploadMultipart(request(multipart([
    { name: 'parent_id', body: '11111111-1111-4111-8111-111111111111' },
  ]))), 'invalid_request')
  await assertError(parseUploadMultipart(request(multipart([
    { name: 'parent_id', filename: 'parent.txt', body: 'x' },
    { name: 'file', filename: 'x', body: 'x' },
  ]))), 'invalid_request')
})
