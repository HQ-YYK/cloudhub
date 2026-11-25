import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import { onRequest as login } from '../api/auth/login.ts'
import { createD1AuthRepository } from './d1-auth-repository.ts'
import { LOGIN_BLOCK_MS, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES } from './auth.ts'

const databaseName = 'cloudhub-db'
const testUsername = `integration-${randomUUID()}`
const testIpHash = `ip-${randomUUID()}`

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function runWrangler(command: string) {
  const file = join(tmpdir(), `cloudhub-d1-test-${randomUUID()}.sql`)
  writeFileSync(file, command)
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
              return (runWrangler(expandedSql)[0]?.results?.[0] ?? null) as T | null
            },
            async run() {
              runWrangler(expandedSql)
              return { success: true }
            },
          }
        },
      }
    },
  }
  return db as unknown as D1Database
}

function attemptRow() {
  const result = runWrangler(`
    SELECT failed_count, window_started_at, blocked_until
    FROM login_attempts
    WHERE username_key = ${sqlString(testUsername)}
      AND ip_hash = ${sqlString(testIpHash)}
  `)
  return result[0]?.results?.[0] as {
    failed_count: number
    window_started_at: string
    blocked_until: string | null
  } | undefined
}

function clearTestRows() {
  runWrangler(`DELETE FROM login_attempts WHERE username_key = ${sqlString(testUsername)}`)
}

test.beforeEach(() => {
  clearTestRows()
})

test.after(() => {
  clearTestRows()
})

test('real local D1 records the first failure and increments within the window', async () => {
  const repository = createD1AuthRepository(createCliDatabase())
  const start = '2030-01-01T00:00:00.000Z'

  await repository.recordLoginFailure(testUsername, testIpHash, start, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES, LOGIN_BLOCK_MS)
  assert.deepEqual(attemptRow(), {
    failed_count: 1,
    window_started_at: start,
    blocked_until: null,
  })

  await repository.recordLoginFailure(testUsername, testIpHash, '2030-01-01T00:01:00.000Z', LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES, LOGIN_BLOCK_MS)
  assert.equal(attemptRow()?.failed_count, 2)
})

test('real local D1 sets the block on the fifth failure and keeps it during blocked calls', async () => {
  const repository = createD1AuthRepository(createCliDatabase())
  const start = '2030-01-02T00:00:00.000Z'

  for (let index = 0; index < 5; index += 1) {
    await repository.recordLoginFailure(
      testUsername,
      testIpHash,
      new Date(Date.parse(start) + index * 60_000).toISOString(),
      LOGIN_WINDOW_MS,
      MAX_LOGIN_FAILURES,
      LOGIN_BLOCK_MS,
    )
  }

  const row = attemptRow()
  assert.equal(row?.failed_count, 5)
  assert.equal(row?.blocked_until, '2030-01-02T00:19:00.000Z')
})

test('real local D1 login route rejects blocked requests without recording another failure', async () => {
  const routeUsername = `route-${randomUUID()}`
  const routeIp = `route-ip-${randomUUID()}`
  const db = createCliDatabase()

  try {
    const ipHash = await import('./auth.ts').then(({ sha256 }) => sha256(routeIp))
    const blockedUntil = new Date(Date.now() + LOGIN_BLOCK_MS).toISOString()
    runWrangler(`
      INSERT INTO login_attempts (username_key, ip_hash, failed_count, window_started_at, blocked_until)
      VALUES (
        ${sqlString(routeUsername)},
        ${sqlString(ipHash)},
        5,
        ${sqlString(new Date().toISOString())},
        ${sqlString(blockedUntil)}
      )
    `)

    const before = runWrangler(`
      SELECT failed_count, blocked_until
      FROM login_attempts
      WHERE username_key = ${sqlString(routeUsername)}
    `)[0]?.results?.[0]
    assert.equal((before as { failed_count: number }).failed_count, 5)

    const blocked = await login({
      request: new Request('https://cloudhub.test/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: 'https://cloudhub.test',
          'CF-Connecting-IP': routeIp,
        },
        body: JSON.stringify({ username: routeUsername, authKey: 'A'.repeat(43) }),
      }),
      env: { DB: db },
    } as never)
    assert.equal(blocked.status, 401)

    const after = runWrangler(`
      SELECT failed_count, blocked_until
      FROM login_attempts
      WHERE username_key = ${sqlString(routeUsername)}
    `)[0]?.results?.[0]
    assert.deepEqual(after, before)
  } finally {
    runWrangler(`DELETE FROM login_attempts WHERE username_key = ${sqlString(routeUsername)}`)
  }
})

test('real local D1 direct failure recording extends an active block when called again', async () => {
  const repository = createD1AuthRepository(createCliDatabase())
  const start = '2030-01-02T00:00:00.000Z'

  for (let index = 0; index < 5; index += 1) {
    await repository.recordLoginFailure(
      testUsername,
      testIpHash,
      new Date(Date.parse(start) + index * 60_000).toISOString(),
      LOGIN_WINDOW_MS,
      MAX_LOGIN_FAILURES,
      LOGIN_BLOCK_MS,
    )
  }

  await repository.recordLoginFailure(
    testUsername,
    testIpHash,
    '2030-01-02T00:05:00.000Z',
    LOGIN_WINDOW_MS,
    MAX_LOGIN_FAILURES,
    LOGIN_BLOCK_MS,
  )
  assert.equal(attemptRow()?.blocked_until, '2030-01-02T00:20:00.000Z')
})

test('real local D1 resets after the window and treats the exact boundary as expired', async () => {
  const repository = createD1AuthRepository(createCliDatabase())
  const start = '2030-01-03T00:00:00.000Z'

  await repository.recordLoginFailure(testUsername, testIpHash, start, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES, LOGIN_BLOCK_MS)
  await repository.recordLoginFailure(
    testUsername,
    testIpHash,
    '2030-01-03T00:14:59.000Z',
    LOGIN_WINDOW_MS,
    MAX_LOGIN_FAILURES,
    LOGIN_BLOCK_MS,
  )
  assert.equal(attemptRow()?.failed_count, 2)

  await repository.recordLoginFailure(
    testUsername,
    testIpHash,
    '2030-01-03T00:15:00.000Z',
    LOGIN_WINDOW_MS,
    MAX_LOGIN_FAILURES,
    LOGIN_BLOCK_MS,
  )
  assert.deepEqual(attemptRow(), {
    failed_count: 1,
    window_started_at: '2030-01-03T00:15:00.000Z',
    blocked_until: null,
  })
})

test('real local D1 allows a failure after the block expires', async () => {
  const repository = createD1AuthRepository(createCliDatabase())
  const start = '2030-01-04T00:00:00.000Z'

  for (let index = 0; index < 5; index += 1) {
    await repository.recordLoginFailure(
      testUsername,
      testIpHash,
      new Date(Date.parse(start) + index * 60_000).toISOString(),
      LOGIN_WINDOW_MS,
      MAX_LOGIN_FAILURES,
      LOGIN_BLOCK_MS,
    )
  }

  await repository.recordLoginFailure(
    testUsername,
    testIpHash,
    '2030-01-04T00:20:00.000Z',
    LOGIN_WINDOW_MS,
    MAX_LOGIN_FAILURES,
    LOGIN_BLOCK_MS,
  )
  assert.deepEqual(attemptRow(), {
    failed_count: 1,
    window_started_at: '2030-01-04T00:20:00.000Z',
    blocked_until: null,
  })
})

test('concurrent real local D1 failure records preserve every increment', async () => {
  const start = '2030-01-05T00:00:00.000Z'
  const children = Array.from({ length: 8 }, () => spawn(
    process.execPath,
    ['--experimental-strip-types', 'scripts/d1-record-login-failure.mjs', databaseName, testUsername, testIpHash, start],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ))

  const results = await Promise.all(children.map((child) => new Promise<number>((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(code)
      else reject(new Error(`concurrent writer failed (${code}): ${stderr}`))
    })
  })))

  assert.equal(results.length, 8)
  assert.equal(attemptRow()?.failed_count, 8)
  assert.equal(attemptRow()?.blocked_until, '2030-01-05T00:15:00.000Z')
})
