import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveFromPassword, unwrapMasterKey } from '../src/crypto/index.ts'
import {
  DEFAULT_KDF_ITERATIONS,
  DEFAULT_PASSWORD_ITERATIONS,
  buildUserRecord,
  userInsertSql,
  validateRole,
  validateUsername,
} from './create-user.mjs'

test('username and role validation match the server rules', () => {
  assert.equal(validateUsername('admin'), true)
  assert.equal(validateUsername('a.b-c_d'), true)
  assert.equal(validateUsername(''), false)
  assert.equal(validateUsername('a'.repeat(33)), false)
  assert.equal(validateUsername('中文'), false)
  assert.equal(validateUsername('a b'), false)

  assert.equal(validateRole('admin'), true)
  assert.equal(validateRole('user'), true)
  assert.equal(validateRole('owner'), false)
})

test('buildUserRecord produces a full insert with correctly formatted fields', async () => {
  const record = await buildUserRecord({
    username: 'admin',
    role: 'admin',
    password: 'correct horse battery staple',
    id: 'user-1',
    kdfIterations: 1000,
    now: new Date('2026-01-01T00:00:00.000Z'),
  })

  assert.equal(record.id, 'user-1')
  assert.equal(record.username, 'admin')
  assert.equal(record.role, 'admin')
  assert.equal(record.password_iterations, DEFAULT_PASSWORD_ITERATIONS)
  assert.equal(record.kdf_iterations, 1000)
  assert.equal(record.created_at, '2026-01-01T00:00:00.000Z')

  assert.match(record.kdf_salt, /^[A-Za-z0-9_-]{22}$/)
  assert.match(record.password_hash, /^[A-Za-z0-9_-]{43}$/)
  assert.match(record.password_salt, /^[A-Za-z0-9_-]{22}$/)
  assert.match(record.wrapped_master_key, /^[A-Za-z0-9_-]{80}$/)
  assert.match(record.recovery_wrapped_key, /^[A-Za-z0-9_-]{80}$/)

  const groups = record.recoveryCode.split('-')
  assert.equal(groups.length, 13)
  for (const group of groups) assert.equal(group.length, 4)

  const sql = userInsertSql(record)
  assert.ok(sql.startsWith('INSERT INTO users ('))
  assert.ok(sql.includes('password_hash'))
  assert.ok(sql.includes('kdf_salt'))
  assert.ok(sql.includes('kdf_iterations'))
  assert.ok(sql.includes('wrapped_master_key'))
  assert.ok(sql.includes('recovery_wrapped_key'))
  assert.ok(sql.includes('keys_updated_at'))
  assert.ok(sql.includes('must_change_password'))
  assert.ok(sql.includes("'admin'"))
  assert.ok(sql.includes("'user-1'"))
})

test('the wrapped master key opens with the same password', async () => {
  const password = 'correct horse battery staple'
  const record = await buildUserRecord({
    username: 'admin',
    role: 'user',
    password,
    id: 'user-2',
    kdfIterations: 1000,
  })

  const { wrapKey } = await deriveFromPassword(password, record.kdf_salt, record.kdf_iterations)
  const mk = await unwrapMasterKey(record.wrapped_master_key, wrapKey, 'user-2')
  assert.equal(mk.length, 32)
})

test('DEFAULT_KDF_ITERATIONS matches the server', () => {
  assert.equal(DEFAULT_KDF_ITERATIONS, 600000)
})
