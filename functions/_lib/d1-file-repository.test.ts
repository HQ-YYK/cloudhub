import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { createD1FileRepository } from './d1-file-repository.ts'
import { FileRepositoryConflictError } from './file-repository.ts'

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

const directory = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  parentId: null,
  name: 'Documents',
  nameKey: 'documents',
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

test('does not map foreign-key, check, or other unique errors to a name conflict', async () => {
  for (const message of [
    'FOREIGN KEY constraint failed',
    'CHECK constraint failed: files.kind',
    'UNIQUE constraint failed: files.id',
  ]) {
    await assert.rejects(
      () => createD1FileRepository(databaseWithInsertError(message)).createDirectory(directory),
      (error: unknown) => !(error instanceof FileRepositoryConflictError)
        && error instanceof Error
        && error.message === message,
    )
  }
})
