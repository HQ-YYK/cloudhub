import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { createD1PasskeyRepository } from './d1-passkey-repository.ts'

const databaseName = 'cloudhub-db'
const testUserId = randomUUID()
const testUsername = `integration-${randomUUID()}`

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function runWrangler(command: string) {
  const file = join(tmpdir(), `cloudhub-d1-test-${randomUUID()}.sql`)
  writeFileSync(file, `PRAGMA foreign_keys = ON;\n${command}`)
  let output: string
  try {
    output = execFileSync('pnpm.cmd', [
      'exec',
      'wrangler',
      'd1',
      'execute',
      databaseName,
      '--local',
      `--file=${file}`,
      '--json',
    ], { encoding: 'utf8', shell: true })
  } finally {
    unlinkSync(file)
  }
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error(`Wrangler did not return JSON: ${output}`)
  return JSON.parse(output.slice(jsonStart)) as Array<{
    results?: Array<Record<string, unknown>>
  }>
}

function firstRow(command: string) {
  for (const entry of runWrangler(command)) {
    if (entry.results && entry.results.length > 0) return entry.results[0]
  }
  return undefined
}

function createCliDatabase() {
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          let valueIndex = 0
          const expandedSql = sql.replaceAll('?', () => {
            const value = values[valueIndex++]
            if (typeof value === 'number') return String(value)
            if (value === null || value === undefined) return 'NULL'
            return sqlString(String(value))
          })
          return {
            async first<T>() {
              return (firstRow(expandedSql) ?? null) as T | null
            },
            async run() {
              runWrangler(expandedSql)
              return { success: true, meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }
  return db as unknown as D1Database
}

function cleanup() {
  runWrangler(`DELETE FROM users WHERE id = ${sqlString(testUserId)}`)
}

test.beforeEach(() => {
  cleanup()
})

test.after(() => {
  cleanup()
})

test('0015 migration stores passkeys and cascades their deletion with the user', async () => {
  runWrangler(`
    INSERT INTO users (id, username, password_hash, password_salt, password_iterations, created_at, updated_at, disabled, role, must_change_password)
    VALUES (
      ${sqlString(testUserId)},
      ${sqlString(testUsername)},
      'x',
      'x',
      310000,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      0,
      'user',
      0
    )
  `)

  const repository = createD1PasskeyRepository(createCliDatabase())
  const inserted = await repository.createPasskey({
    id: 'credential-1',
    userId: testUserId,
    publicKey: 'AAAA',
    algorithm: -7,
    signCount: 0,
    name: 'Test',
    transports: '["internal"]',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(inserted, true)

  const found = await repository.findPasskeyById('credential-1')
  assert.equal(found?.user_id, testUserId)

  const before = firstRow(`SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ${sqlString(testUserId)}`)
  assert.equal((before as { count: number }).count, 1)

  runWrangler(`DELETE FROM users WHERE id = ${sqlString(testUserId)}`)
  const after = firstRow(`SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ${sqlString(testUserId)}`)
  assert.equal((after as { count: number }).count, 0)
})
