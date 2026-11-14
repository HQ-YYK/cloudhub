import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import {
  BlobStoreError,
  type BlobHead,
  type BlobObject,
  type BlobPutInput,
  type BlobStore,
} from '../../_lib/blob-store.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { MockBlobStore } from '../../_lib/mock-blob-store.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type NewPendingFile,
} from '../../_lib/file-repository.ts'
import { createUploadHandler } from './upload.ts'

const userId = '11111111-1111-4111-8111-111111111111'
const parentId = '22222222-2222-4222-8222-222222222222'
const boundary = 'UploadBoundary'
const encoder = new TextEncoder()

interface PartInput {
  name: string
  body: string
  filename?: string
  contentType?: string
}

function multipart(parts: PartInput[]) {
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    chunks.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n`
      + (part.contentType === undefined ? '' : `Content-Type: ${part.contentType}\r\n`)
      + '\r\n',
    ))
    chunks.push(encoder.encode(part.body), encoder.encode('\r\n'))
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))
  const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function request(parts: PartInput[]) {
  const body = multipart(parts)
  return new Request('https://cloudhub.test/api/files/upload', {
    method: 'POST',
    headers: {
      Origin: 'https://cloudhub.test',
      Cookie: 'cloudhub_session=valid-token',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.byteLength),
    },
    body,
  })
}

function directory(owner_id = userId): FileRecord {
  return {
    id: parentId,
    owner_id,
    parent_id: null,
    kind: 'directory',
    name: 'Documents',
    name_key: 'documents',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
  }
}

function authRepository(authenticated = true): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => authenticated
      ? { session_id: 'session', id: userId, username: 'alice' }
      : null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
  }
}

function fileRepository(options: {
  authenticated?: boolean
  parent?: FileRecord | null
  conflict?: boolean
  readyFailure?: boolean
  cleanupFailure?: boolean
} = {}) {
  let pending: FileRecord | null = null
  const records: FileRecord[] = []
  const repository: FileRepository = {
    listChildren: async () => [],
    listVisibleChildren: async () => [],
    findDirectory: async (ownerId) => {
      if (options.parent === undefined) return directory()
      return options.parent?.owner_id === ownerId ? options.parent : null
    },
    createDirectory: async () => {
      throw new Error('not_used')
    },
    findFile: async () => null,
    createPendingFile: async (input: NewPendingFile) => {
      if (options.conflict) throw new FileRepositoryConflictError()
      pending = {
        id: input.id,
        owner_id: input.ownerId,
        parent_id: input.parentId,
        kind: 'file',
        name: input.name,
        name_key: input.nameKey,
        object_key: input.objectKey,
        size_bytes: input.sizeBytes,
        mime_type: input.mimeType,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        deleted_at: null,
        storage_status: 'pending',
      }
      records.push(pending)
      return pending
    },
    updateFileStorageStatus: async (_ownerId, id, from, to, updatedAt) => {
      if (to === 'ready' && options.readyFailure) return null
      if (!pending || pending.id !== id || pending.storage_status !== from) return null
      pending.storage_status = to
      pending.updated_at = updatedAt
      return pending
    },
    softDeleteFile: async () => null,
  }
  return { repository, records }
}

class FailingBlobStore implements BlobStore {
  private readonly delegate = new MockBlobStore()
  private readonly putFailure: boolean
  private readonly deleteFailure: boolean

  constructor(putFailure: boolean, deleteFailure = false) {
    this.putFailure = putFailure
    this.deleteFailure = deleteFailure
  }

  async put(input: BlobPutInput): Promise<BlobHead> {
    const head = await this.delegate.put(input)
    if (this.putFailure) throw new BlobStoreError('unavailable', 'test_put_failure')
    return head
  }

  async get(objectKey: string): Promise<BlobObject> {
    return this.delegate.get(objectKey)
  }

  async head(objectKey: string): Promise<BlobHead> {
    return this.delegate.head(objectKey)
  }

  async delete(objectKey: string) {
    if (this.deleteFailure) throw new BlobStoreError('unavailable', 'test_delete_failure')
    await this.delegate.delete(objectKey)
  }
}

function handler(options: {
  authenticated?: boolean
  parent?: FileRecord | null
  conflict?: boolean
  readyFailure?: boolean
  blobStore?: BlobStore
} = {}) {
  const files = fileRepository(options)
  const env = { DB: {} as D1Database } satisfies AuthEnv
  const onRequest = createUploadHandler({
    createAuthRepository: () => authRepository(options.authenticated ?? true),
    createFileRepository: () => files.repository,
    createBlobStore: () => options.blobStore ?? new MockBlobStore(),
  })
  return { env, files, onRequest }
}

function context(onRequest: ReturnType<typeof createUploadHandler>, requestValue: Request, env: AuthEnv) {
  return onRequest({ request: requestValue, env } as never)
}

test('rejects unauthenticated, missing-file, and non-multipart requests', async () => {
  const unauthenticated = handler({ authenticated: false })
  const response = await context(unauthenticated.onRequest, request([
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), unauthenticated.env)
  assert.equal(response.status, 401)

  const missingFile = handler()
  const missingResponse = await context(missingFile.onRequest, request([
    { name: 'parent_id', body: parentId },
  ]), missingFile.env)
  assert.equal(missingResponse.status, 400)

  const nonMultipart = handler()
  const nonMultipartRequest = new Request('https://cloudhub.test/api/files/upload', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', Cookie: 'cloudhub_session=valid-token' },
    body: 'x',
  })
  const nonMultipartResponse = await context(nonMultipart.onRequest, nonMultipartRequest, nonMultipart.env)
  assert.equal(nonMultipartResponse.status, 400)
})

test('uploads a file with owner isolation and a public response', async () => {
  const fixture = handler()
  const response = await context(fixture.onRequest, request([
    { name: 'file', filename: 'hello.txt', contentType: 'text/plain', body: 'hello' },
  ]), fixture.env)
  assert.equal(response.status, 201)
  const body = await response.json() as { item: Record<string, unknown> }
  assert.equal(body.item.name, 'hello.txt')
  assert.equal(body.item.size_bytes, 5)
  assert.equal(body.item.storage_status, undefined)
  assert.equal(body.item.owner_id, undefined)
  assert.equal(body.item.object_key, undefined)
  assert.equal(body.item.azure_url, undefined)
})

test('rejects forged owner fields and invalid or foreign parents', async () => {
  const forged = handler()
  const forgedResponse = await context(forged.onRequest, request([
    { name: 'owner_id', body: userId },
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), forged.env)
  assert.equal(forgedResponse.status, 400)
  assert.equal(forged.files.records.length, 0)

  const invalidParent = handler()
  const invalidParentResponse = await context(invalidParent.onRequest, request([
    { name: 'parent_id', body: 'not-an-id' },
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), invalidParent.env)
  assert.equal(invalidParentResponse.status, 404)

  const foreignParent = handler({ parent: directory('33333333-3333-4333-8333-333333333333') })
  const foreignResponse = await context(foreignParent.onRequest, request([
    { name: 'parent_id', body: parentId },
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), foreignParent.env)
  assert.equal(foreignResponse.status, 404)
})

test('maps conflicts, missing Azure configuration, and Blob failures safely', async () => {
  const conflict = handler({ conflict: true })
  const conflictResponse = await context(conflict.onRequest, request([
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), conflict.env)
  assert.equal(conflictResponse.status, 409)

  const missingAzure = createUploadHandler()
  const missingAzureResponse = await context(missingAzure, request([
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), { DB: {} as D1Database })
  assert.equal(missingAzureResponse.status, 503)
  assert.deepEqual(await missingAzureResponse.json(), { error: 'service_unavailable' })

  const blobFailure = handler({ blobStore: new FailingBlobStore(true) })
  const blobFailureResponse = await context(blobFailure.onRequest, request([
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), blobFailure.env)
  assert.equal(blobFailureResponse.status, 503)
})

test('maps ready-state and cleanup failures without reporting success', async () => {
  const readyFailure = handler({ readyFailure: true })
  const readyResponse = await context(readyFailure.onRequest, request([
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), readyFailure.env)
  assert.equal(readyResponse.status, 503)
  assert.equal(readyFailure.files.records[0]?.storage_status, 'failed')

  const cleanupFailure = handler({
    blobStore: new FailingBlobStore(true, true),
  })
  const cleanupResponse = await context(cleanupFailure.onRequest, request([
    { name: 'file', filename: 'x.txt', body: 'x' },
  ]), cleanupFailure.env)
  assert.equal(cleanupResponse.status, 503)
  assert.equal(cleanupFailure.files.records[0]?.storage_status, 'failed')
})
