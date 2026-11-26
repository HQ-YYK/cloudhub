import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createD1FileRepository } from '../functions/_lib/d1-file-repository.ts'

const [, , databaseName, ownerId, parentId, name, id] = process.argv

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function runWrangler(sql) {
  const file = join(tmpdir(), `cloudhub-file-test-${randomUUID()}.sql`)
  writeFileSync(file, sql)
  try {
    return execFileSync('pnpm.cmd', [
      'exec', 'wrangler', 'd1', 'execute', databaseName, '--local', `--file=${file}`, '--json',
    ], { encoding: 'utf8', shell: true })
  } finally {
    unlinkSync(file)
  }
}

const db = {
  prepare(sql) {
    return {
      bind(...values) {
        let index = 0
        const expandedSql = sql.replaceAll('?', () => {
          const value = values[index++]
          if (value === null || value === undefined) return 'NULL'
          return sqlString(String(value))
        })
        return {
          async run() {
            runWrangler(expandedSql)
            return { success: true }
          },
          async first() {
            const output = runWrangler(expandedSql)
            const start = output.indexOf('[')
            const result = JSON.parse(output.slice(start))
            return result[0]?.results?.[0] ?? null
          },
        }
      },
    }
  },
}

for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    await createD1FileRepository(db).createDirectory({
      id,
      ownerId,
      parentId: parentId === 'NULL' ? null : parentId,
      name,
      nameKey: name.toLocaleLowerCase('en-US'),
      enc: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    process.exit(0)
  } catch (error) {
    const message = [
      error,
      error?.stdout,
      error?.stderr,
    ].filter(Boolean).join('\n')
    if ((!message.includes('SQLITE_BUSY') && !message.includes('internal error')) || attempt === 19) {
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
