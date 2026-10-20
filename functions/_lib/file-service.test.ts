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
      }
      records.push(record)
      return record
    },
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
