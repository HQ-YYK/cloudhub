import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildUserRecord,
  readHiddenPassword,
  userInsertSql,
  validateRole,
  validateUsername,
} from './create-user.mjs'

function parseArgs(argv) {
  const args = { username: undefined, role: undefined, id: undefined }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--username') args.username = value
    else if (flag === '--role') args.role = value
    else if (flag === '--id') args.id = value
    else throw new Error(`未知参数：${flag}`)
  }
  return args
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (!args.username || !validateUsername(args.username)) {
    throw new Error('用户名只能包含字母、数字、点、下划线和短横线，长度 1–32。')
  }
  if (!validateRole(args.role)) {
    throw new Error('--role 只能是 admin 或 user。')
  }

  const password = await readHiddenPassword('密码（输入隐藏）: ')
  const confirm = await readHiddenPassword('再输入一次密码: ')
  if (!password) throw new Error('密码不能为空。')
  if (password !== confirm) throw new Error('两次输入的密码不一致。')

  const record = await buildUserRecord({
    username: args.username,
    role: args.role,
    password,
    id: args.id,
  })

  const outputPath = join(process.cwd(), '.tmp', 'create-user.sql')
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
  writeFileSync(outputPath, userInsertSql(record), { encoding: 'utf8' })

  console.log('')
  console.log(`已生成 ${outputPath}`)
  console.log('')
  console.log('恢复码（忘记密码时唯一找回方式，请立即保存）：')
  console.log(record.recoveryCode)
  console.log('')
  console.log('把这条记录写进线上数据库：')
  console.log('pnpm exec wrangler d1 execute cloudhub-db --remote --file=.tmp/create-user.sql')
} catch (error) {
  console.error(error instanceof Error ? error.message : '创建用户失败。')
  process.exitCode = 1
}
