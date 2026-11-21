import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import {
  BlobStoreError,
  type BlobHead,
  type BlobObject,
  type BlobStore,
} from '../../_lib/blob-store.ts'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import {
  type FileRecord,
  type FileRepository,
} from '../../_lib/file-repository.ts'
import { createDownloadHandler } from './[id]/download.ts'

const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'
const fileId = '33333333-3333-4333-8333-333333333333'
const objectKey = `objects/${fileId}`

function authRepository(authenticated = true, userId = ownerId): AuthRepository {
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

function fileRecord(options: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId,
    owner_id: ownerId,
    parent_id: null,
    kind: 'file',
    name: '报告.txt',
    name_key: '报告.txt',
    object_key: objectKey,
    size_bytes: 5,
    mime_type: 'text/plain',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
    ...options,
  }
}

function fileRepository(record: FileRecord | null): FileRepository {
  return {
    listChildren: async () => [],
    listVisibleChildren: async () => [],
    findDirectory: async () => null,
    createDirectory: async () => {
      throw new Error('not_used')
    },
    findFile: async (ownerIdValue, id) => (
      record
      && record.owner_id === ownerIdValue
      && record.id === id
      && record.kind === 'file'
      && record.deleted_at === null
        ? record
        : null
    ),
    createPendingFile: async () => {
      throw new Error('not_used')
    },
    updateFileStorageStatus: async () => null,
    softDeleteFile: async () => null,
  }
}

class RecordingBlobStore implements BlobStore {
  readonly requestedKeys: string[] = []
  private readonly failure: BlobStoreError | null
  private readonly body: Uint8Array

  constructor(body = new Uint8Array([104, 101, 108, 108, 111]), failure?: BlobStoreError) {
    this.body = body
    this.failure = failure ?? null
  }

  async put(): Promise<BlobHead> {
    throw new Error('not_used')
  }

  async get(key: string): Promise<BlobObject> {
    this.requestedKeys.push(key)
    if (this.failure) throw this.failure
    return {
      objectKey: key,
      body: new ReadableStream({
        start: (controller) => {
          controller.enqueue(this.body)
          controller.close()
        },
      }),
      sizeBytes: this.body.byteLength,
      metadata: {},
      contentType: 'text/plain',
      etag: '"download-etag"',
    }
  }

  async head(): Promise<BlobHead> {
    throw new Error('not_used')
  }

  async delete(): Promise<void> {
    throw new Error('not_used')
  }
}

function request(id = fileId, headers: Record<string, string> = {}) {
  return new Request(`https://cloudhub.test/api/files/${id}/download`, {
    method: 'GET',
    headers: {
      Cookie: 'cloudhub_session=valid-token',
      ...headers,
    },
  })
}

function handler(options: {
  authenticated?: boolean
  userId?: string
  record?: FileRecord | null
  blobStore?: BlobStore
  blobStoreFactoryError?: BlobStoreError
} = {}) {
  const blobStore = options.blobStore ?? new RecordingBlobStore()
  const onRequest = createDownloadHandler({
    createAuthRepository: () => authRepository(options.authenticated ?? true, options.userId ?? ownerId),
    createFileRepository: () => fileRepository(options.record === undefined ? fileRecord() : options.record),
    createBlobStore: () => {
      if (options.blobStoreFactoryError) throw options.blobStoreFactoryError
      return blobStore
    },
  })
  return {
    onRequest,
    env: { DB: {} as D1Database } satisfies AuthEnv,
    blobStore,
  }
}

function context(onRequest: ReturnType<typeof createDownloadHandler>, requestValue: Request, env: AuthEnv) {
  return onRequest({ request: requestValue, env, params: { id: fileId } } as never)
}

test('requires GET, valid IDs, authentication, and a user-owned ready file', async () => {
  const method = handler()
  const methodResponse = await context(
    method.onRequest,
    new Request(`https://cloudhub.test/api/files/${fileId}/download`, { method: 'POST' }),
    method.env,
  )
  assert.equal(methodResponse.status, 405)
  assert.equal(methodResponse.headers.get('Allow'), 'GET')

  const invalid = handler()
  const invalidResponse = await invalid.onRequest({
    request: request('not-an-id'),
    env: invalid.env,
    params: { id: 'not-an-id' },
  } as never)
  assert.equal(invalidResponse.status, 400)

  const unauthenticated = handler({ authenticated: false })
  const unauthenticatedResponse = await context(unauthenticated.onRequest, request(), unauthenticated.env)
  assert.equal(unauthenticatedResponse.status, 401)

  const foreign = handler({ record: fileRecord({ owner_id: otherOwnerId }) })
  const foreignResponse = await context(foreign.onRequest, request(), foreign.env)
  assert.equal(foreignResponse.status, 404)
  assert.equal((foreign.blobStore as RecordingBlobStore).requestedKeys.length, 0)

  const missing = handler({ record: null })
  const missingResponse = await context(missing.onRequest, request(), missing.env)
  assert.equal(missingResponse.status, 404)
})

test('allows only ready, non-deleted files and never directories', async () => {
  for (const storageStatus of ['pending', 'failed', 'deleting'] as const) {
    const current = handler({ record: fileRecord({ storage_status: storageStatus }) })
    const response = await context(current.onRequest, request(), current.env)
    assert.equal(response.status, 404)
    assert.equal((current.blobStore as RecordingBlobStore).requestedKeys.length, 0)
  }

  const deleted = handler({ record: fileRecord({ deleted_at: '2030-01-02T00:00:00.000Z' }) })
  assert.equal((await context(deleted.onRequest, request(), deleted.env)).status, 404)

  const directory = handler({ record: fileRecord({ kind: 'directory', object_key: null }) })
  assert.equal((await context(directory.onRequest, request(), directory.env)).status, 404)
})

test('streams a ready blob and sends safe private download headers', async () => {
  const current = handler()
  const response = await context(current.onRequest, request(), current.env)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'hello')
  assert.equal(response.headers.get('Content-Type'), 'text/plain')
  assert.equal(response.headers.get('Content-Length'), '5')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  const disposition = response.headers.get('Content-Disposition') ?? ''
  assert.match(disposition, /^attachment; filename="/u)
  assert.match(disposition, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.txt/u)
  assert.doesNotMatch(disposition, /[\r\n]/u)
  assert.deepEqual((current.blobStore as RecordingBlobStore).requestedKeys, [objectKey])
})

test('returns storage_unavailable when the store factory throws and leaves metadata ready', async () => {
  const current = handler({
    blobStoreFactoryError: new BlobStoreError('unavailable', 'storage_not_configured'),
  })
  const response = await context(current.onRequest, request(), current.env)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_unavailable' })
  assert.equal(current.blobStore === undefined, false)
})

test('sanitizes hostile names and maps BlobStore failures without leaking details', async () => {
  const hostile = handler({
    record: fileRecord({ name: 'evil"\r\nX-Leak: true.txt' }),
  })
  const hostileResponse = await context(hostile.onRequest, request(), hostile.env)
  const disposition = hostileResponse.headers.get('Content-Disposition') ?? ''
  assert.equal(hostileResponse.status, 200)
  assert.doesNotMatch(disposition, /[\r\n]/u)
  assert.match(disposition, /filename="evil___X-Leak: true\.txt"/u)

  for (const failure of [
    new BlobStoreError('not_found', 'internal-object-key'),
    new BlobStoreError('unavailable', 'storage-not-configured'),
  ]) {
    const current = handler({ blobStore: new RecordingBlobStore(undefined, failure) })
    const response = await context(current.onRequest, request(), current.env)
    assert.equal(response.status, 503)
    const body = await response.text()
    assert.equal(body, '{"error":"storage_unavailable"}')
    assert.doesNotMatch(body, /internal-object-key|storage-not-configured/u)
  }
})
