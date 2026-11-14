import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthRepository } from './auth-repository.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
} from './file-repository.ts'
import {
  createDirectory,
  FileServiceError,
  listFiles,
  normalizeFileName,
  publicFileRecord,
} from './file-service.ts'
import { assertFileStorageTransition, FileStorageStateError } from './file-storage-state.ts'

const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice' }
const otherOwner = { id: '22222222-2222-4222-8222-222222222222', username: 'bob' }

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

function fileRepository(initial: FileRecord[] = []): FileRepository & { records: FileRecord[] } {
  const records = initial
  return {
    records,
    listChildren: async (ownerId, parentId) => records.filter(
      (record) => record.owner_id === ownerId
        && record.parent_id === parentId
        && !record.deleted_at,
    ),
    listVisibleChildren: async (ownerId, parentId) => records.filter(
      (record) => record.owner_id === ownerId
        && record.parent_id === parentId
        && !record.deleted_at
        && (record.kind === 'directory' || record.storage_status === 'ready'),
    ),
    findDirectory: async (ownerId, id) => records.find(
      (record) => record.owner_id === ownerId
        && record.id === id
        && record.kind === 'directory'
        && !record.deleted_at,
    ) ?? null,
    createDirectory: async (input) => {
      if (records.some((record) => record.owner_id === input.ownerId
        && record.parent_id === input.parentId
        && record.name_key === input.nameKey
        && !record.deleted_at)) {
        throw new FileRepositoryConflictError()
      }
      const record: FileRecord = {
        id: input.id,
        owner_id: input.ownerId,
        parent_id: input.parentId,
        kind: 'directory',
        name: input.name,
        name_key: input.nameKey,
        object_key: null,
        size_bytes: null,
        mime_type: null,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        deleted_at: null,
          storage_status: 'ready',
        }
      records.push(record)
      return record
    },
    findFile: async (ownerId, id) => records.find(
      (record) => record.owner_id === ownerId && record.id === id && record.kind === 'file' && !record.deleted_at,
    ) ?? null,
    createPendingFile: async () => {
      throw new Error('not_used_in_directory_tests')
    },
    updateFileStorageStatus: async (ownerId, id, from, to, updatedAt) => {
      const record = records.find((candidate) => candidate.owner_id === ownerId
        && candidate.id === id
        && candidate.kind === 'file'
        && candidate.storage_status === from
        && !candidate.deleted_at)
      if (!record) return null
      record.storage_status = to
      record.updated_at = updatedAt
      return record
    },
    softDeleteFile: async () => null,
  }
}

const request = new Request('https://cloudhub.test/api/files', {
  headers: { Cookie: 'cloudhub_session=valid-token' },
})

test('normalizes names and rejects unsafe names', () => {
  assert.deepEqual(normalizeFileName('  Documents  '), {
    name: 'Documents',
    nameKey: 'documents',
  })
  for (const name of ['', '   ', 'a/b', `bad${String.fromCharCode(10)}name`, 'x'.repeat(256)]) {
    assert.throws(() => normalizeFileName(name), (error: unknown) => (
      error instanceof FileServiceError && error.code === 'invalid_name'
    ))
  }
})

test('creates root and child directories, while enforcing ownership', async () => {
  const repository = fileRepository()
  const root = await createDirectory(authRepository(), repository, request, null, 'Documents')
  assert.equal(root.parent_id, null)
  const child = await createDirectory(authRepository(), repository, request, root.id, 'Notes')
  assert.equal(child.parent_id, root.id)
  await assert.rejects(
    () => createDirectory(authRepository(otherOwner), repository, request, root.id, 'Private'),
    (error: unknown) => error instanceof FileServiceError && error.code === 'invalid_parent',
  )
})

test('lists only direct children for the authenticated owner', async () => {
  const repository = fileRepository()
  const root = await createDirectory(authRepository(), repository, request, null, 'Root')
  await createDirectory(authRepository(), repository, request, root.id, 'Child')
  await createDirectory(authRepository(), repository, request, null, 'Sibling')
  const items = await listFiles(authRepository(), repository, request, root.id)
  assert.deepEqual(items.map((item) => item.name), ['Child'])
  assert.ok(items.every((item) => !Object.hasOwn(publicFileRecord(item), 'object_key')))
})

test('visible lists include directories and ready files, but hide other storage states', async () => {
  const repository = fileRepository([
    ...(['pending', 'ready', 'failed', 'deleting'] as const).map((storage_status, index): FileRecord => ({
      id: `33333333-3333-4333-8333-33333333333${index}`,
      owner_id: owner.id,
      parent_id: null,
      kind: 'file',
      name: `${storage_status}.bin`,
      name_key: `${storage_status}.bin`,
      object_key: `objects/${storage_status}`,
      size_bytes: 1,
      mime_type: 'application/octet-stream',
      created_at: '2030-01-01T00:00:00.000Z',
      updated_at: '2030-01-01T00:00:00.000Z',
      deleted_at: null,
      storage_status,
    })),
  ])
  await createDirectory(authRepository(), repository, request, null, 'Documents')
  const visible = await listFiles(authRepository(), repository, request, null)
  assert.deepEqual(visible.map((item) => item.name).sort(), ['Documents', 'ready.bin'])
})

test('enforces active case-insensitive names but permits different parents and soft-deleted names', async () => {
  const repository = fileRepository()
  const root = await createDirectory(authRepository(), repository, request, null, 'Root')
  await assert.rejects(
    () => createDirectory(authRepository(), repository, request, null, 'root'),
    (error: unknown) => error instanceof FileServiceError && error.code === 'conflict',
  )
  const child = await createDirectory(authRepository(), repository, request, root.id, 'root')
  assert.equal(child.parent_id, root.id)
  repository.records[0].deleted_at = '2030-01-01T00:00:00.000Z'
  const replacement = await createDirectory(authRepository(), repository, request, null, 'ROOT')
  assert.equal(replacement.parent_id, null)
})

test('storage transitions enforce the state machine and owner isolation', async () => {
  const repository = fileRepository([{
    id: '33333333-3333-4333-8333-333333333333',
    owner_id: owner.id,
    parent_id: null,
    kind: 'file',
    name: 'upload.bin',
    name_key: 'upload.bin',
    object_key: 'objects/file/content',
    size_bytes: null,
    mime_type: 'application/octet-stream',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'pending',
  }])
  const { transitionFileStorage } = await import('./file-service.ts')
  const ready = await transitionFileStorage(
    authRepository(),
    repository,
    request,
    '33333333-3333-4333-8333-333333333333',
    'pending',
    'ready',
    '2030-01-01T00:01:00.000Z',
  )
  assert.equal(ready.storage_status, 'ready')
  await assert.rejects(
    () => transitionFileStorage(
      authRepository(),
      repository,
      request,
      ready.id,
      'ready',
      'pending',
    ),
    (error: unknown) => error instanceof FileServiceError && error.code === 'invalid_storage_transition',
  )
  await assert.rejects(
    () => transitionFileStorage(
      authRepository(otherOwner),
      repository,
      request,
      ready.id,
      'ready',
      'deleting',
    ),
    (error: unknown) => error instanceof FileServiceError && error.code === 'resource_not_found',
  )
})

test('accepts only the documented storage transition matrix', () => {
  const allowed = new Set([
    'pending->ready',
    'pending->failed',
    'pending->deleting',
    'ready->deleting',
    'failed->pending',
    'failed->deleting',
    'deleting->failed',
  ])
  const statuses = ['pending', 'ready', 'failed', 'deleting'] as const
  for (const from of statuses) {
    for (const to of statuses) {
      if (allowed.has(`${from}->${to}`)) {
        assert.doesNotThrow(() => assertFileStorageTransition(from, to))
      } else {
        assert.throws(
          () => assertFileStorageTransition(from, to),
          (error: unknown) => error instanceof FileStorageStateError
            && error.from === from
            && error.to === to,
        )
      }
    }
  }
})
