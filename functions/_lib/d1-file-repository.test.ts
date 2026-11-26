import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { createD1FileRepository } from './d1-file-repository.ts'
import { FileRepositoryConflictError, FileRepositoryIdConflictError } from './file-repository.ts'

function databaseWithInsertError(message: string) {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          throw new Error(message)
        },
      }),
    }),
  } as unknown as D1Database
}

function databaseWithUpdateResult(changes: number) {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true, meta: { changes } }),
        first: async () => null,
      }),
    }),
  } as unknown as D1Database
}

function databaseWithAtomicStorageUpdate() {
  let status = 'pending'
  const record = {
    id: '33333333-3333-4333-8333-333333333333',
    owner_id: directory.ownerId,
    parent_id: null,
    kind: 'file',
    name: 'race.bin',
    name_key: 'race.bin',
    object_key: 'objects/race',
    size_bytes: null,
    mime_type: null,
    created_at: directory.createdAt,
    updated_at: directory.updatedAt,
    deleted_at: null,
    storage_status: status,
  }
  return {
    prepare: (query: string) => ({
      bind: (...parameters: unknown[]) => ({
        run: async () => {
          if (!query.trimStart().startsWith('UPDATE')) return { success: true, meta: { changes: 1 } }
          const [to, , id, ownerId, from] = parameters
          const changed = id === record.id
            && ownerId === record.owner_id
            && from === status
          if (changed) status = String(to)
          return { success: true, meta: { changes: changed ? 1 : 0 } }
        },
        first: async () => ({ ...record, storage_status: status }),
      }),
    }),
  } as unknown as D1Database
}

const directory = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  parentId: null,
  name: 'Documents',
  nameKey: 'documents',
  enc: 1,
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
}

test('maps only the active-name unique index error to a repository conflict', async () => {
  await assert.rejects(
    () => createD1FileRepository(databaseWithInsertError(
      "UNIQUE constraint failed: index 'idx_files_active_name'",
    )).createDirectory(directory),
    (error: unknown) => error instanceof FileRepositoryConflictError,
  )
})

test('does not map foreign-key or check errors to a name conflict', async () => {
  for (const message of [
    'FOREIGN KEY constraint failed',
    'CHECK constraint failed: files.kind',
  ]) {
    await assert.rejects(
      () => createD1FileRepository(databaseWithInsertError(message)).createDirectory(directory),
      (error: unknown) => !(error instanceof FileRepositoryConflictError)
        && error instanceof Error
        && error.message === message,
    )
  }
})

test('maps a primary-key collision to an id conflict', async () => {
  await assert.rejects(
    () => createD1FileRepository(databaseWithInsertError('UNIQUE constraint failed: files.id')).createDirectory(directory),
    (error: unknown) => error instanceof FileRepositoryIdConflictError,
  )
})

test('returns null for an atomic storage update that changes no rows', async () => {
  const repository = createD1FileRepository(databaseWithUpdateResult(0))
  assert.equal(
    await repository.updateFileStorageStatus(
      directory.ownerId,
      directory.id,
      'pending',
      'ready',
      directory.updatedAt,
    ),
    null,
  )
})

test('allows at most one concurrent transition for the same expected state', async () => {
  const repository = createD1FileRepository(databaseWithAtomicStorageUpdate())
  const results = await Promise.all([
    repository.updateFileStorageStatus(directory.ownerId, '33333333-3333-4333-8333-333333333333', 'pending', 'ready', directory.updatedAt),
    repository.updateFileStorageStatus(directory.ownerId, '33333333-3333-4333-8333-333333333333', 'pending', 'failed', directory.updatedAt),
  ])
  assert.equal(results.filter(Boolean).length, 1)
})
