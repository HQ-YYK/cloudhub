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
import { createDeleteHandler } from './[id].ts'

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

function record(options: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId,
    owner_id: ownerId,
    parent_id: null,
    kind: 'file',
    name: 'file.txt',
    name_key: 'file.txt',
    object_key: objectKey,
    size_bytes: 4,
    mime_type: 'text/plain',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
    ...options,
  }
}

class TestRepository implements FileRepository {
  readonly updates: string[] = []
  readonly record: FileRecord | null
  updateFailure = false
  softDeleteFailure = false

  constructor(initial: FileRecord | null) {
    this.record = initial
  }

  listChildren = async () => []
  listVisibleChildren = async () => []
  findDirectory = async () => null
  createDirectory = async () => {
    throw new Error('not_used')
  }
  findFile = async (userId: string, id: string) => (
    this.record
    && this.record.owner_id === userId
    && this.record.id === id
    && this.record.kind === 'file'
    && this.record.deleted_at === null
      ? this.record
      : null
  )
  createPendingFile = async () => {
    throw new Error('not_used')
  }
  updateFileStorageStatus = async (
    userId: string,
    id: string,
    from: FileRecord['storage_status'],
    to: FileRecord['storage_status'],
    updatedAt: string,
  ) => {
    this.updates.push(`${from}->${to}`)
    if (
      this.updateFailure
      || !this.record
      || this.record.owner_id !== userId
      || this.record.id !== id
      || this.record.storage_status !== from
      || this.record.deleted_at !== null
    ) return null
    this.record.storage_status = to
    this.record.updated_at = updatedAt
    return this.record
  }
  softDeleteFile = async (userId: string, id: string, deletedAt: string, updatedAt: string) => {
    if (
      this.softDeleteFailure
      || !this.record
      || this.record.owner_id !== userId
      || this.record.id !== id
      || this.record.storage_status !== 'deleting'
      || this.record.deleted_at !== null
    ) return null
    this.record.deleted_at = deletedAt
    this.record.updated_at = updatedAt
    return this.record
  }
}

class RecordingBlobStore implements BlobStore {
  readonly deletedKeys: string[] = []
  failure: BlobStoreError | null = null

  async put(): Promise<BlobHead> {
    throw new Error('not_used')
  }
  async get(): Promise<BlobObject> {
    throw new Error('not_used')
  }
  async head(): Promise<BlobHead> {
    throw new Error('not_used')
  }
  async delete(key: string) {
    this.deletedKeys.push(key)
    if (this.failure) throw this.failure
  }
}

function request(id = fileId, headers: Record<string, string> = {}) {
  return new Request(`https://cloudhub.test/api/files/${id}`, {
    method: 'DELETE',
    headers: {
      Origin: 'https://cloudhub.test',
      Cookie: 'cloudhub_session=valid-token',
      ...headers,
    },
  })
}

function setup(options: {
  authenticated?: boolean
  userId?: string
  record?: FileRecord | null
  repository?: TestRepository
  blobStore?: RecordingBlobStore
  blobStoreFactoryError?: BlobStoreError
} = {}) {
  const repository = options.repository ?? new TestRepository(
    options.record === undefined ? record() : options.record,
  )
  const blobStore = options.blobStore ?? new RecordingBlobStore()
  const onRequest = createDeleteHandler({
    createAuthRepository: () => authRepository(options.authenticated ?? true, options.userId ?? ownerId),
    createFileRepository: () => repository,
    createBlobStore: () => {
      if (options.blobStoreFactoryError) throw options.blobStoreFactoryError
      return blobStore
    },
  })
  return {
    onRequest,
    env: { DB: {} as D1Database } satisfies AuthEnv,
    repository,
    blobStore,
  }
}

function context(onRequest: ReturnType<typeof createDeleteHandler>, requestValue: Request, env: AuthEnv) {
  return onRequest({ request: requestValue, env, params: { id: fileId } } as never)
}

test('enforces method, same-origin, ID, authentication, and ownership', async () => {
  const method = setup()
  const methodResponse = await context(
    method.onRequest,
    new Request(`https://cloudhub.test/api/files/${fileId}`, { method: 'GET' }),
    method.env,
  )
  assert.equal(methodResponse.status, 405)

  const crossOrigin = setup()
  const crossOriginResponse = await crossOrigin.onRequest({
    request: request(fileId, { Origin: 'https://attacker.test' }),
    env: crossOrigin.env,
    params: { id: fileId },
  } as never)
  assert.equal(crossOriginResponse.status, 403)

  const invalid = setup()
  const invalidResponse = await invalid.onRequest({
    request: request('invalid'),
    env: invalid.env,
    params: { id: 'invalid' },
  } as never)
  assert.equal(invalidResponse.status, 400)

  const unauthenticated = setup({ authenticated: false })
  const unauthenticatedResponse = await context(unauthenticated.onRequest, request(), unauthenticated.env)
  assert.equal(unauthenticatedResponse.status, 401)

  const foreign = setup({ record: record({ owner_id: otherOwnerId }) })
  assert.equal((await context(foreign.onRequest, request(), foreign.env)).status, 404)
  assert.deepEqual(foreign.blobStore.deletedKeys, [])

  const missing = setup({ record: null })
  assert.equal((await context(missing.onRequest, request(), missing.env)).status, 404)
})

test('soft deletes ready, pending, and failed files after idempotent Blob deletion', async () => {
  for (const storageStatus of ['ready', 'pending', 'failed'] as const) {
    const blobStore = new RecordingBlobStore()
    blobStore.failure = new BlobStoreError('not_found', 'blob_missing')
    const current = setup({ record: record({ storage_status: storageStatus }), blobStore })
    const response = await context(current.onRequest, request(), current.env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    assert.equal(current.repository.record?.deleted_at, current.repository.record?.updated_at)
    assert.deepEqual(blobStore.deletedKeys, [objectKey])
  }

  const directory = setup({ record: record({ kind: 'directory', object_key: null }) })
  assert.equal((await context(directory.onRequest, request(), directory.env)).status, 404)

  const alreadyDeleted = setup({ record: record({ deleted_at: '2030-01-02T00:00:00.000Z' }) })
  assert.equal((await context(alreadyDeleted.onRequest, request(), alreadyDeleted.env)).status, 404)
})

test('does not delete a Blob when the deleting transition loses a race', async () => {
  const current = setup({ record: record({ storage_status: 'deleting' }) })
  const response = await context(current.onRequest, request(), current.env)
  assert.equal(response.status, 409)
  assert.deepEqual(current.blobStore.deletedKeys, [])

  const failedTransition = setup()
  failedTransition.repository.updateFailure = true
  assert.equal((await context(failedTransition.onRequest, request(), failedTransition.env)).status, 409)
  assert.deepEqual(failedTransition.blobStore.deletedKeys, [])
})

test('returns storage_unavailable when the store factory throws and leaves the record ready', async () => {
  const current = setup({
    blobStoreFactoryError: new BlobStoreError('unavailable', 'storage_not_configured'),
  })
  const response = await context(current.onRequest, request(), current.env)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_unavailable' })
  assert.equal(current.repository.record?.storage_status, 'ready')
  assert.equal(current.repository.record?.deleted_at, null)
  assert.deepEqual(current.repository.updates, [])
  assert.deepEqual(current.blobStore.deletedKeys, [])
})

test('restores failed after Blob deletion failure and never soft deletes metadata', async () => {
  const current = setup()
  current.blobStore.failure = new BlobStoreError('unavailable', 'storage_unavailable')
  const response = await context(current.onRequest, request(), current.env)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_unavailable' })
  assert.equal(current.repository.record?.storage_status, 'failed')
  assert.equal(current.repository.record?.deleted_at, null)
  assert.deepEqual(current.blobStore.deletedKeys, [objectKey])
  assert.equal(current.repository.updates.join(','), 'ready->deleting,deleting->failed')
})

test('keeps deleting when Blob was removed but D1 soft delete fails', async () => {
  const current = setup()
  current.repository.softDeleteFailure = true
  const response = await context(current.onRequest, request(), current.env)
  assert.equal(response.status, 503)
  assert.equal(current.repository.record?.storage_status, 'deleting')
  assert.equal(current.repository.record?.deleted_at, null)
  assert.deepEqual(current.blobStore.deletedKeys, [objectKey])
})

test('only one concurrent request obtains the deleting transition', async () => {
  const repository = new TestRepository(record())
  const blobStore = new RecordingBlobStore()
  const first = setup({ repository, blobStore })
  const second = setup({ repository, blobStore })
  const responses = await Promise.all([
    context(first.onRequest, request(), first.env),
    context(second.onRequest, request(), second.env),
  ])
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 404])
  assert.deepEqual(blobStore.deletedKeys, [objectKey])
})
