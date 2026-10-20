import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { createD1FileRepository } from './d1-file-repository.ts'

const databaseName = 'cloudhub-db'
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'
const userInsert = `
  INSERT OR IGNORE INTO users (
    id, username, password_hash, password_salt, password_iterations, disabled, created_at, updated_at
  ) VALUES (
    '${ownerId}', 'file-test-owner', 'x', 'x', 310000, 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
  ), (
    '${otherOwnerId}', 'file-test-other', 'x', 'x', 310000, 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
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
        const details = `${error}\n${(error as { stderr?: string }).stderr ?? ''}`
        if ((!details.includes('SQLITE_BUSY') && !details.includes('internal error')) || attempt === 19) {
          throw error
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
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}') AND parent_id IS NOT NULL;
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}') AND parent_id IS NULL
  `)
  runWrangler(userInsert)
}

test.before(() => {
  runWrangler(userInsert)
})

test.after(() => {
  runWrangler(`
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}') AND parent_id IS NOT NULL;
    DELETE FROM files
    WHERE owner_id IN ('${ownerId}', '${otherOwnerId}') AND parent_id IS NULL
  `)
  runWrangler(`DELETE FROM users WHERE id IN ('${ownerId}', '${otherOwnerId}')`)
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
  }))
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
