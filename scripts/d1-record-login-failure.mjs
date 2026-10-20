import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createD1AuthRepository } from '../functions/_lib/d1-auth-repository.ts'

const [, , databaseName, username, ipHash, now] = process.argv

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function runWrangler(command) {
  const file = join(tmpdir(), `cloudhub-d1-test-${randomUUID()}.sql`)
  writeFileSync(file, command)
  try {
    return execFileSync('pnpm.cmd', [
      'exec',
      'wrangler',
      'd1',
      'execute',
      databaseName,
      '--local',
      `--file=${file}`,
    ], { encoding: 'utf8', shell: true })
  } finally {
    unlinkSync(file)
  }
}

const db = {
  prepare(sql) {
    return {
      bind(...values) {
        let valueIndex = 0
        const expandedSql = sql.replaceAll('?', () => {
          const value = values[valueIndex++]
          if (typeof value === 'number') return String(value)
          if (value === null || value === undefined) return 'NULL'
          return sqlString(String(value))
        })
        return {
          async run() {
            runWrangler(expandedSql)
            return { success: true }
          },
        }
      },
    }
  },
}

for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    await createD1AuthRepository(db).recordLoginFailure(username, ipHash, now, 900000, 5, 900000)
    break
  } catch (error) {
    const message = String(error)
    if (
      (!message.includes('SQLITE_BUSY') && !message.includes('internal error'))
      || attempt === 19
    ) throw error
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
