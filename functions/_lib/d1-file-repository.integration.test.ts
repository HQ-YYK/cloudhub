import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { createD1FileRepository } from './d1-file-repository.ts'
import { FileRepositoryConflictError } from './file-repository.ts'

const databaseName = 'cloudhub-db'
const ownerId = randomUUID()
const otherOwnerId = randomUUID()
const sentinelId = randomUUID()
const ownerUsername = `file-test-owner-${randomUUID()}`
const otherOwnerUsername = `file-test-other-${randomUUID()}`
const sentinelUsername = `file-test-sentinel-${randomUUID()}`
const userInsert = `
  INSERT OR IGNORE INTO users (
    id, username, password_hash, password_salt, password_iterations, disabled, created_at, updated_at
  ) VALUES (
    '${ownerId}', '${ownerUsername}', 'x', 'x', 310000, 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
  ), (
    '${otherOwnerId}', '${otherOwnerUsername}', 'x', 'x', 310000, 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
  )
`

function runWrangler(sql: string) {
  const file = join(tmpdir(), `cloudhub-file-test-${randomUUID()}.sql`)
  writeFileSync(file, sql)
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const output = execFileSync('pnpm.cmd', [
          'exec', 'wrangler', 'd1', 'execute', databaseName, '--local', `--file=${file}`, '--json',
        ], { encoding: 'utf8', shell: true })
        const start = output.indexOf('[')
        if (start < 0) throw new Error(`Wrangler did not return JSON: ${output}`)
        return JSON.parse(output.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>
      } catch (error) {
        const details = [
          error,
          (error as { stdout?: string }).stdout,
          (error as { stderr?: string }).stderr,
        ].filter(Boolean).join('\n')
        if ((!details.includes('SQLITE_BUSY') && !details.includes('internal error')) || attempt === 19) {
          throw new Error(details, { cause: error })
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
    throw new Error('local D1 retry limit exceeded')
  } finally {
    unlinkSync(file)
  }
}

function database() {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          let index = 0
          const expanded = sql.replaceAll('?', () => {
            const value = values[index++]
            if (value === null || value === undefined) return 'NULL'
            return `'${String(value).replaceAll("'", "''")}'`
          })
          return {
            async run() {
              runWrangler(expanded)
              return { success: true }
            },
            async first<T>() {
              return (runWrangler(expanded)[0]?.results?.[0] ?? null) as T | null
            },
            async all<T>() {
              return { results: (runWrangler(expanded)[0]?.results ?? []) as T[] }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

function cleanup() {
  runWrangler(`
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}')
      AND parent_id IS NOT NULL;
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}')
      AND parent_id IS NULL
  `)
  runWrangler(userInsert)
}

test.before(() => {
  runWrangler(userInsert)
  runWrangler(`
    INSERT INTO users (
      id, username, password_hash, password_salt, password_iterations, disabled, created_at, updated_at
    ) VALUES (
      '${sentinelId}', '${sentinelUsername}', 'x', 'x', 310000, 0,
      '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
    );
    INSERT INTO files (
      id, owner_id, parent_id, kind, name, name_key, object_key,
      size_bytes, mime_type, created_at, updated_at, deleted_at
    ) VALUES (
      '${randomUUID()}', '${sentinelId}', NULL, 'directory', 'Keep me', 'keep me',
      NULL, NULL, NULL, '2030-01-01T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z', NULL
    )
  `)
})

test.after(() => {
  runWrangler(`
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}') AND parent_id IS NOT NULL;
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}') AND parent_id IS NULL
  `)
  const sentinel = runWrangler(`
    SELECT COUNT(*) AS count
    FROM files
    WHERE owner_id = '${sentinelId}' AND name_key = 'keep me' AND deleted_at IS NULL
  `)[0]?.results?.[0] as { count: number }
  assert.equal(sentinel.count, 1)
  runWrangler(`DELETE FROM files WHERE owner_id = '${sentinelId}'`)
  runWrangler(`DELETE FROM users WHERE id IN ('${ownerId}', '${otherOwnerId}', '${sentinelId}')`)
})

test('local D1 enforces ownership, direct children, soft-delete reuse, and active name uniqueness', async () => {
  cleanup()
  const repository = createD1FileRepository(database())
  const root = await repository.createDirectory({
    id: randomUUID(), ownerId, parentId: null, name: 'Documents', nameKey: 'documents',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
  })
  const child = await repository.createDirectory({
    id: randomUUID(), ownerId, parentId: root.id, name: 'Notes', nameKey: 'notes',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
  })
  assert.equal((await repository.listChildren(ownerId, root.id))[0]?.id, child.id)
  assert.equal(await repository.findDirectory(otherOwnerId, root.id), null)
  await assert.rejects(() => repository.createDirectory({
    id: randomUUID(), ownerId, parentId: null, name: 'documents', nameKey: 'documents',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
  }), (error: unknown) => error instanceof FileRepositoryConflictError)
  runWrangler(`UPDATE files SET deleted_at = '2030-01-02T00:00:00.000Z' WHERE id = '${root.id}'`)
  await repository.createDirectory({
    id: randomUUID(), ownerId, parentId: null, name: 'DOCUMENTS', nameKey: 'documents',
    createdAt: '2030-01-03T00:00:00.000Z', updatedAt: '2030-01-03T00:00:00.000Z',
  })
})

test('local D1 concurrent inserts allow only one active same-name directory', async () => {
  cleanup()
  const ids = Array.from({ length: 4 }, () => randomUUID())
  const results = await Promise.all(ids.map((id) => new Promise<number>((resolve) => {
    const child = spawn('node', [
      '--experimental-strip-types', 'scripts/d1-create-directory.mjs',
      databaseName, ownerId, 'NULL', 'Concurrent', id,
    ], { stdio: 'ignore' })
    child.on('close', (code) => resolve(code ?? 1))
  })))
  assert.equal(results.filter((code) => code === 0).length, 1)
  const rows = runWrangler(`
    SELECT COUNT(*) AS count FROM files
    WHERE owner_id = '${ownerId}' AND name_key = 'concurrent' AND deleted_at IS NULL
  `)[0]?.results?.[0] as { count: number }
  assert.equal(rows.count, 1)
})

test('local D1 tracks file storage states, permits failed-name retry, and isolates owners', async () => {
  cleanup()
  const repository = createD1FileRepository(database())
  const fileId = randomUUID()
  const retryId = randomUUID()
  const input = {
    id: fileId,
    ownerId,
    parentId: null,
    name: 'upload.bin',
    nameKey: 'upload.bin',
    objectKey: `objects/${fileId}/content`,
    mimeType: 'application/octet-stream',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
  }
  const pending = await repository.createPendingFile(input)
  assert.equal(pending.storage_status, 'pending')
  assert.equal((await repository.listChildren(ownerId, null))[0]?.storage_status, 'pending')
  assert.equal(await repository.findFile(otherOwnerId, fileId), null)

  const failed = await repository.updateFileStorageStatus(
    ownerId,
    fileId,
    'pending',
    'failed',
    '2030-01-01T00:01:00.000Z',
  )
  assert.equal(failed?.storage_status, 'failed')

  const retry = await repository.createPendingFile({ ...input, id: retryId, objectKey: `objects/${retryId}/content` })
  assert.equal(retry.storage_status, 'pending')
  assert.equal(
    await repository.updateFileStorageStatus(
      otherOwnerId,
      fileId,
      'failed',
      'pending',
      '2030-01-01T00:02:00.000Z',
    ),
    null,
  )
  await assert.rejects(
    () => repository.createPendingFile({
      ...input,
      id: randomUUID(),
      objectKey: `objects/${randomUUID()}/content`,
    }),
    (error: unknown) => error instanceof FileRepositoryConflictError,
  )
})
