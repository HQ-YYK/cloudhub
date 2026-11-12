import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthRepository } from './auth-repository.ts'
import {
  BlobStoreError,
  type BlobHead,
  type BlobObject,
  type BlobPutInput,
  type BlobStore,
} from './blob-store.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type NewPendingFile,
} from './file-repository.ts'
import {
  FileServiceError,
} from './file-service.ts'
import {
  FileUploadError,
  MAX_UPLOAD_SIZE_BYTES,
  uploadFile,
} from './file-upload-service.ts'

const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice' }
const parentId = '33333333-3333-4333-8333-333333333333'
const now = new Date('2030-01-01T00:00:00.000Z')

function authRepository(user = owner): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => ({ session_id: 'session', ...user }),
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
  }
}

function directory(ownerId = owner.id): FileRecord {
  return {
    id: parentId,
    owner_id: ownerId,
    parent_id: null,
    kind: 'directory',
    name: 'Documents',
    name_key: 'documents',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    deleted_at: null,
    storage_status: 'ready',
  }
}

function createRepository(options: {
  parent?: FileRecord | null
  conflict?: boolean
  createError?: Error
  readyResult?: FileRecord | null
  failError?: Error
} = {}) {
  const calls: string[] = []
  const records: FileRecord[] = []
  let pending: FileRecord | null = null
  const repository: FileRepository = {
    listChildren: async () => [],
    listVisibleChildren: async () => [],
    findDirectory: async (ownerId, id) => {
      calls.push('findDirectory')
      return id === parentId && ownerId === owner.id
        ? (options.parent === undefined ? directory() : options.parent)
        : null
    },
    createDirectory: async () => {
      throw new Error('not_used')
    },
    findFile: async () => null,
    createPendingFile: async (input: NewPendingFile) => {
      calls.push('createPending')
      if (options.createError) throw options.createError
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
    updateFileStorageStatus: async (ownerId, id, from, to, updatedAt) => {
      calls.push(`update:${to}`)
      if (to === 'failed' && options.failError) throw options.failError
      if (
        to === 'ready'
        && options.readyResult === null
      ) return null
      if (
        !pending
        || pending.id !== id
        || pending.owner_id !== ownerId
        || pending.storage_status !== from
        || pending.deleted_at
      ) return null
      pending.storage_status = to
      pending.updated_at = updatedAt
      return options.readyResult ?? pending
    },
  }
  return { repository, calls, records }
}

class RecordingBlobStore implements BlobStore {
  readonly calls: string[] = []
  readonly puts: BlobPutInput[] = []
  readonly deletedKeys: string[] = []
  private readonly objects = new Set<string>()
  private readonly putError: BlobStoreError | null
  private readonly putThenError: BlobStoreError | null
  private readonly deleteError: BlobStoreError | null
  private readonly sizeDelta: number

  constructor(options: {
    putError?: BlobStoreError
    putThenError?: BlobStoreError
    deleteError?: BlobStoreError
    sizeDelta?: number
  } = {}) {
    this.putError = options.putError ?? null
    this.putThenError = options.putThenError ?? null
    this.deleteError = options.deleteError ?? null
    this.sizeDelta = options.sizeDelta ?? 0
  }

  async put(input: BlobPutInput): Promise<BlobHead> {
    this.calls.push('put')
    this.puts.push(input)
    if (this.putError) throw this.putError
    const body = input.body instanceof Uint8Array ? input.body : new Uint8Array()
    if (this.putThenError) {
      this.objects.add(input.objectKey)
      throw this.putThenError
    }
    this.objects.add(input.objectKey)
    return {
      objectKey: input.objectKey,
      sizeBytes: body.byteLength + this.sizeDelta,
      metadata: input.metadata ?? {},
      contentType: input.contentType ?? null,
      etag: '"mock-test"',
    }
  }

  async get(): Promise<BlobObject> {
    throw new Error('not_used')
  }

  async head(): Promise<BlobHead> {
    throw new Error('not_used')
  }

  async delete(objectKey: string) {
    this.calls.push('delete')
    this.deletedKeys.push(objectKey)
    if (this.deleteError) throw this.deleteError
    this.objects.delete(objectKey)
  }

  get hasObject() {
    return this.objects.size > 0
  }
}

function request(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('https://cloudhub.test/api/files/upload', {
    method: 'POST',
    headers: {
      Cookie: 'cloudhub_session=valid-token',
      ...headers,
    },
    body,
  })
}

const input = {
  name: 'hello.txt',
  parentId: null,
  mimeType: 'text/plain',
}

test('uploads in order, persists the actual size, and only returns ready after Blob success', async () => {
  const { repository, calls, records } = createRepository()
  const blobStore = new RecordingBlobStore()
  const result = await uploadFile(
    authRepository(),
    repository,
    blobStore,
    request('hello'),
    input,
    now,
  )

  assert.equal(result.storage_status, 'ready')
  assert.equal(result.size_bytes, 5)
  assert.deepEqual(calls, ['createPending', 'update:ready'])
  assert.deepEqual(blobStore.calls, ['put'])
  assert.equal(blobStore.puts[0]?.overwrite, false)
  assert.equal(blobStore.puts[0]?.contentType, 'text/plain')
  assert.match(blobStore.puts[0]?.objectKey ?? '', /^objects\/[0-9a-f-]+\/content$/u)
  assert.equal(records[0]?.storage_status, 'ready')
})

test('rejects unauthenticated, invalid parent, invalid MIME, and oversized uploads before Blob access', async () => {
  const cases: Array<{
    name: string
    auth: AuthRepository
    repository: ReturnType<typeof createRepository>['repository']
    request: Request
    input: typeof input
    code: FileServiceError['code']
  }> = [
    {
      name: 'unauthenticated',
      auth: authRepository(),
      repository: createRepository().repository,
      request: request('body'),
      input,
      code: 'unauthorized',
    },
    {
      name: 'invalid MIME',
      auth: authRepository(),
      repository: createRepository().repository,
      request: request('body'),
      input: { ...input, mimeType: 'not-a-mime' },
      code: 'invalid_mime',
    },
    {
      name: 'oversized content length',
      auth: authRepository(),
      repository: createRepository().repository,
      request: request(null, { 'Content-Length': String(MAX_UPLOAD_SIZE_BYTES + 1) }),
      input,
      code: 'too_large',
    },
  ]
  for (const testCase of cases) {
    const blobStore = new RecordingBlobStore()
    const auth = testCase.name === 'unauthenticated'
      ? { ...authRepository(), findSessionUser: async () => null }
      : testCase.auth
    await assert.rejects(
      uploadFile(auth, testCase.repository, blobStore, testCase.request, testCase.input, now),
      (error: unknown) => error instanceof FileServiceError && error.code === testCase.code,
      testCase.name,
    )
    assert.deepEqual(blobStore.calls, [], testCase.name)
  }

  const parentRepository = createRepository({ parent: null })
  const blobStore = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(
      authRepository(),
      parentRepository.repository,
      blobStore,
      request('body'),
      { ...input, parentId },
      now,
    ),
    (error: unknown) => error instanceof FileServiceError && error.code === 'invalid_parent',
  )
  assert.deepEqual(blobStore.calls, [])
})

test('maps same-name conflicts and does not write Blob or reveal another owner parent', async () => {
  const conflict = createRepository({ conflict: true })
  const conflictBlob = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(authRepository(), conflict.repository, conflictBlob, request('body'), input, now),
    (error: unknown) => error instanceof FileServiceError && error.code === 'conflict',
  )
  assert.deepEqual(conflictBlob.calls, [])

  const otherParent = createRepository({ parent: null })
  const otherBlob = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(
      authRepository(),
      otherParent.repository,
      otherBlob,
      request('body'),
      { ...input, parentId },
      now,
    ),
    (error: unknown) => error instanceof FileServiceError && error.code === 'invalid_parent',
  )
  assert.deepEqual(otherBlob.calls, [])
})

test('marks pending failed and deletes a possibly written Blob after put failure', async () => {
  const { repository, calls } = createRepository()
  const blobStore = new RecordingBlobStore({
    putThenError: new BlobStoreError('unavailable'),
  })
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request('body'), input, now),
    (error: unknown) => error instanceof FileUploadError && error.code === 'upload_failed',
  )
  assert.deepEqual(calls, ['createPending', 'update:failed'])
  assert.deepEqual(blobStore.calls, ['put', 'delete'])
})

test('cleans a written Blob when pending to ready loses a state race', async () => {
  const { repository, calls } = createRepository({ readyResult: null })
  const blobStore = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request('body'), input, now, ),
    (error: unknown) => error instanceof FileUploadError && error.code === 'upload_failed',
  )
  assert.deepEqual(calls, ['createPending', 'update:ready', 'update:failed'])
  assert.deepEqual(blobStore.calls, ['put', 'delete'])
})

test('does not delete a Blob when the failed transition also loses its state race', async () => {
  const { repository, calls } = createRepository({ readyResult: null })
  const originalUpdate = repository.updateFileStorageStatus
  repository.updateFileStorageStatus = async (ownerId, id, from, to, updatedAt) => {
    calls.push(`update:${to}`)
    if (to === 'failed') return null
    return originalUpdate(ownerId, id, from, to, updatedAt)
  }
  const blobStore = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request('body'), input, now),
    (error: unknown) => error instanceof FileUploadError && error.code === 'upload_failed',
  )
  assert.deepEqual(blobStore.calls, ['put'])
})

test('reports cleanup failure and does not hide failure to mark metadata', async () => {
  const { repository } = createRepository()
  const blobStore = new RecordingBlobStore({
    putError: new BlobStoreError('unavailable'),
    deleteError: new BlobStoreError('unavailable'),
  })
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request('body'), input, now),
    (error: unknown) => error instanceof FileUploadError && error.code === 'cleanup_failed',
  )
})

test('does not call BlobStore when creating pending metadata fails', async () => {
  const { repository } = createRepository({ createError: new Error('database failure') })
  const blobStore = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request('body'), input, now),
    /database failure/u,
  )
  assert.deepEqual(blobStore.calls, [])
})

test('rejects actual bodies over the limit, including when Content-Length is absent', async () => {
  const body = new Uint8Array(MAX_UPLOAD_SIZE_BYTES + 1)
  const { repository } = createRepository()
  const blobStore = new RecordingBlobStore()
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request(body, { 'Content-Type': 'application/octet-stream' }), input, now),
    (error: unknown) => error instanceof FileUploadError && error.code === 'too_large',
  )
  assert.deepEqual(blobStore.calls, [])
})

test('rejects Content-Length values that do not match the actual body', async () => {
  const cases = [
    { declaredSize: '5', body: new Uint8Array(3) },
    { declaredSize: '3', body: new Uint8Array(5) },
  ]
  for (const { declaredSize, body } of cases) {
    const { repository, records } = createRepository()
    const blobStore = new RecordingBlobStore()
    const mismatchedRequest = request(body)
    mismatchedRequest.headers.set('Content-Length', declaredSize)
    await assert.rejects(
      uploadFile(
        authRepository(),
        repository,
        blobStore,
        mismatchedRequest,
        input,
        now,
      ),
      (error: unknown) => error instanceof FileUploadError && error.code === 'invalid_body',
    )
    assert.deepEqual(blobStore.calls, [])
    assert.deepEqual(records, [])
  }
})

test('rejects a nonzero Content-Length when the request has no body', async () => {
  const { repository } = createRepository()
  const blobStore = new RecordingBlobStore()
  const emptyRequest = request(null)
  emptyRequest.headers.set('Content-Length', '1')
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, emptyRequest, input, now),
    (error: unknown) => error instanceof FileUploadError && error.code === 'invalid_body',
  )
  assert.deepEqual(blobStore.calls, [])
})

test('cleans an object that was stored before BlobStore reported an error', async () => {
  const { repository, calls } = createRepository()
  const blobStore = new RecordingBlobStore({
    putThenError: new BlobStoreError('unavailable'),
  })
  await assert.rejects(
    uploadFile(authRepository(), repository, blobStore, request('body'), input, now),
    (error: unknown) => error instanceof FileUploadError && error.code === 'upload_failed',
  )
  assert.deepEqual(calls, ['createPending', 'update:failed'])
  assert.deepEqual(blobStore.calls, ['put', 'delete'])
  assert.equal(blobStore.hasObject, false)
})
