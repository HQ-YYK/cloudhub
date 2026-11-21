import { createInterface } from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'

const DATABASE_NAME = 'cloudhub-db'
const USERNAME = 'test'
const ITERATIONS = 100000
const encoder = new TextEncoder()

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function parseWranglerJson(output) {
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error('Wrangler did not return JSON.')
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

function readHidden(question) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY) {
      reject(new Error('Run this command in an interactive terminal.'))
      return
    }

    output.write(question)
    input.setRawMode(true)
    input.resume()
    let value = ''
    const onData = (chunk) => {
      const character = chunk.toString()
      if (character === '\r' || character === '\n') {
        input.setRawMode(false)
        input.pause()
        input.removeListener('data', onData)
        output.write('\n')
        resolve(value)
      } else if (character === '\u0003') {
        input.setRawMode(false)
        input.pause()
        input.removeListener('data', onData)
        reject(new Error('Cancelled.'))
      } else if (character === '\u007f') {
        value = value.slice(0, -1)
      } else {
        value += character
      }
    }
    input.on('data', onData)
  })
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

async function createPasswordRecord(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return {
    hash: base64Url(new Uint8Array(bits)),
    salt: base64Url(salt),
  }
}

function getSingleResult(result) {
  const rows = result.flatMap((entry) => entry.results ?? [])
  if (rows.length !== 1) throw new Error('Unexpected local D1 result.')
  return rows[0]
}

try {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Run this command in an interactive terminal.')
  }

  const countResult = runLocalSql(
    `SELECT COUNT(*) AS matching_users FROM users WHERE username = ${sqlString(USERNAME)};`,
  )
  const countRow = getSingleResult(countResult)
  if (Number(countRow.matching_users) !== 1) {
    throw new Error('Expected exactly one local test user.')
  }

  const readline = createInterface({ input, output })
  const username = (await readline.question(`Username [${USERNAME}]: `)).trim() || USERNAME
  readline.close()
  if (username !== USERNAME) throw new Error(`This script only updates "${USERNAME}".`)

  const password = await readHidden('Password (input hidden): ')
  if (!password) throw new Error('Password is required.')

  const passwordRecord = await createPasswordRecord(password)
  const now = new Date().toISOString()
  const updateResult = runLocalSql(`
    UPDATE users
    SET password_hash = ${sqlString(passwordRecord.hash)},
        password_salt = ${sqlString(passwordRecord.salt)},
        password_iterations = ${ITERATIONS},
        updated_at = ${sqlString(now)},
        disabled = 0
    WHERE username = ${sqlString(USERNAME)};
    SELECT changes() AS updated_rows;
  `)
  const updateRow = getSingleResult(updateResult)
  if (Number(updateRow.updated_rows) !== 1) {
    throw new Error('Local test user update did not affect exactly one row.')
  }

  const verifyResult = runLocalSql(`
    SELECT username, disabled, length(password_hash) AS hash_length,
      length(password_salt) AS salt_length, password_iterations
    FROM users
    WHERE username = ${sqlString(USERNAME)} LIMIT 1;
  `)
  const verifyRow = getSingleResult(verifyResult)
  if (
    verifyRow.username !== USERNAME ||
    Number(verifyRow.disabled) !== 0 ||
    Number(verifyRow.hash_length) !== 43 ||
    Number(verifyRow.salt_length) !== 22 ||
    Number(verifyRow.password_iterations) !== ITERATIONS
  ) {
    throw new Error('Local test user verification failed.')
  }

  console.log('Local test user initialized successfully.')
  console.log(`database: ${DATABASE_NAME} (local)`)
  console.log(`username: ${USERNAME}`)
  console.log('password format: valid')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local test user initialization failed.')
  process.exitCode = 1
}
