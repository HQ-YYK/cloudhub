import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildUserRecord,
  readHiddenPassword,
  sqlString,
  userUpsertSql,
} from './create-user.mjs'

const DATABASE_NAME = 'cloudhub-db'
const USERNAME = 'test'
const ROLE = 'admin'

function parseWranglerJson(output) {
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error('wrangler 没有返回 JSON。')
  return JSON.parse(output.slice(jsonStart))
}

function runLocalSql(sql) {
  const file = join(tmpdir(), `cloudhub-local-test-user-${randomUUID()}.sql`)
  writeFileSync(file, sql, { encoding: 'utf8', flag: 'wx' })
  try {
    const output = execFileSync('pnpm.cmd', [
      'exec',
      'wrangler',
      'd1',
      'execute',
      DATABASE_NAME,
      '--local',
      `--file=${file}`,
      '--json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    return parseWranglerJson(output)
  } finally {
    unlinkSync(file)
  }
}

function getSingleResult(result) {
  const rows = result.flatMap((entry) => entry.results ?? [])
  return rows.length === 0 ? null : rows[0]
}

function resolvePassword(argv) {
  const index = argv.indexOf('--password')
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  if (process.env.CLOUDHUB_TEST_PASSWORD) return process.env.CLOUDHUB_TEST_PASSWORD
  return readHiddenPassword('密码（输入隐藏）: ')
}

try {
  const password = await resolvePassword(process.argv.slice(2))
  if (!password) throw new Error('密码不能为空。')

  let id
  const existing = runLocalSql(`SELECT id FROM users WHERE username = ${sqlString(USERNAME)} LIMIT 1;`)
  const existingRow = getSingleResult(existing)
  id = existingRow ? existingRow.id : randomUUID()

  const record = await buildUserRecord({ username: USERNAME, role: ROLE, password, id })
  runLocalSql(userUpsertSql(record))

  const verify = runLocalSql(`
    SELECT username, disabled, kdf_salt, kdf_iterations,
      length(kdf_salt) AS kdf_salt_length, length(wrapped_master_key) AS wrapped_key_length
    FROM users
    WHERE username = ${sqlString(USERNAME)} LIMIT 1;
  `)
  const row = getSingleResult(verify)
  if (
    !row
    || row.username !== USERNAME
    || Number(row.disabled) !== 0
    || !row.kdf_salt
    || Number(row.kdf_salt_length) !== 22
    || Number(row.wrapped_key_length) !== 80
    || Number(row.kdf_iterations) !== 600000
  ) {
    throw new Error('本地测试用户校验失败。')
  }

  console.log('本地测试用户已就绪。')
  console.log(`数据库: ${DATABASE_NAME} (local)`)
  console.log(`用户名: ${USERNAME}`)
  console.log(`角色: ${ROLE}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : '本地测试用户初始化失败。')
  process.exitCode = 1
}
