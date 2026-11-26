import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { createD1FileRepository } from './d1-file-repository.ts'
import { createD1FileTreeRepository } from './d1-file-tree-repository.ts'

const databaseName = 'cloudhub-db'
const ownerId = randomUUID()
const ownerUsername = `tree-test-owner-${randomUUID()}`
const folderId = randomUUID()
const nullFileId = randomUUID()
const normalFileId = randomUUID()
const earlyFileId = randomUUID()
const shareId = randomUUID()
const folderDeletedAt = '2030-01-10T00:00:00.000Z'
const updatedAt = '2030-01-10T00:00:01.000Z'

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function runWrangler(sql: string) {
  const file = join(tmpdir(), `cloudhub-tree-test-${randomUUID()}.sql`)
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
            return sqlString(String(value))
          })
          return {
            async run() {
              const result = runWrangler(`${expanded}; SELECT changes() AS changes`)
              const changes = Number(result.at(-1)?.results?.[0]?.changes ?? 0)
              return { success: true, meta: { changes } }
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

const userInsert = `
  INSERT OR IGNORE INTO users (
    id, username, password_hash, password_salt, password_iterations, disabled, created_at, updated_at
  ) VALUES (
    ${sqlString(ownerId)}, ${sqlString(ownerUsername)}, 'x', 'x', 100000, 0,
    '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
  )
`

function cleanup() {
  runWrangler(`
    DELETE FROM files WHERE owner_id = ${sqlString(ownerId)} AND parent_id IS NOT NULL;
    DELETE FROM files WHERE owner_id = ${sqlString(ownerId)} AND parent_id IS NULL
  `)
  runWrangler(userInsert)
}

test.before(() => {
  runWrangler(userInsert)
})

test.after(() => {
  runWrangler(`
    DELETE FROM files WHERE owner_id = ${sqlString(ownerId)} AND parent_id IS NOT NULL;
    DELETE FROM files WHERE owner_id = ${sqlString(ownerId)} AND parent_id IS NULL
  `)
  runWrangler(`DELETE FROM users WHERE id = ${sqlString(ownerId)}`)
})

test('trash purge clears an enc=0 Chinese-named folder with null-object, normal, and earlier-deleted files', async () => {
  cleanup()
  runWrangler(`
    INSERT INTO files (
      id, owner_id, parent_id, kind, name, name_key, object_key, size_bytes, mime_type,
      created_at, updated_at, deleted_at, storage_status, enc, wrapped_key
    ) VALUES (
      ${sqlString(folderId)}, ${sqlString(ownerId)}, NULL, 'directory', '旧目录', 'old-dir',
      NULL, NULL, NULL, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', NULL,
      'ready', 0, NULL
    ), (
      ${sqlString(nullFileId)}, ${sqlString(ownerId)}, ${sqlString(folderId)}, 'file', '中断文件', 'interrupted',
      NULL, 12, NULL, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', NULL,
      'failed', 0, NULL
    ), (
      ${sqlString(normalFileId)}, ${sqlString(ownerId)}, ${sqlString(folderId)}, 'file', '正常文件', 'normal',
      'objects/normal', 28, 'application/octet-stream', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', NULL,
      'ready', 0, NULL
    ), (
      ${sqlString(earlyFileId)}, ${sqlString(ownerId)}, ${sqlString(folderId)}, 'file', '先删文件', 'early',
      'objects/early', 10, 'application/octet-stream', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z',
      '2030-01-05T00:00:00.000Z', 'deleting', 0, NULL
    );
    INSERT INTO shares (
      id, owner_id, file_id, token_hash, token_ciphertext, token_iv, expires_at, revoked_at, download_count, created_at
    ) VALUES (
      ${sqlString(shareId)}, ${sqlString(ownerId)}, ${sqlString(normalFileId)}, 'token-hash', 'c', 'i', NULL, NULL, 0,
      '2030-01-01T00:00:00.000Z'
    )
  `)

  const fileRepository = createD1FileRepository(database())
  const treeRepository = createD1FileTreeRepository(database())

  const deleted = await treeRepository.softDeleteFolderTree(ownerId, folderId, folderDeletedAt, updatedAt)
  assert.equal(deleted, 3)

  const batch = await treeRepository.listBatchObjectKeys(ownerId, folderDeletedAt, 40)
  assert.equal(batch.length, 2)
  assert.deepEqual(
    batch.map((record) => record.object_key).sort(),
    [null, 'objects/normal'],
  )

  for (const record of batch) {
    await fileRepository.deleteTrashedFile(ownerId, record.id)
  }
  assert.equal(await treeRepository.countBatchFiles(ownerId, folderDeletedAt), 0)

  // Must not hit the files.parent_id ON DELETE RESTRICT constraint.
  await treeRepository.deleteTrashedBatch(ownerId, folderDeletedAt)

  const remaining = runWrangler(`
    SELECT id, parent_id FROM files WHERE owner_id = ${sqlString(ownerId)}
  `)[0]?.results as Array<{ id: string, parent_id: string | null }>
  assert.deepEqual(remaining, [{ id: earlyFileId, parent_id: null }])

  const shareCount = runWrangler(`
    SELECT COUNT(*) AS count FROM shares WHERE file_id = ${sqlString(normalFileId)}
  `)[0]?.results?.[0] as { count: number }
  assert.equal(shareCount.count, 0)

  // The earlier-deleted file is a standalone trash entry; purge it too.
  await fileRepository.deleteTrashedFile(ownerId, earlyFileId)
  const afterEarly = runWrangler(`
    SELECT COUNT(*) AS count FROM files WHERE owner_id = ${sqlString(ownerId)}
  `)[0]?.results?.[0] as { count: number }
  assert.equal(afterEarly.count, 0)
})
