import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkName, nameProblemMessage, normalizeName, sanitizeDisplayName } from './names.ts'

test('checkName accepts a normal name after trimming', () => {
  assert.deepEqual(checkName('  报告.pdf '), { ok: true, normalized: '报告.pdf' })
})

test('checkName rejects an empty name', () => {
  const result = checkName('   ')
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'empty')
})

test('checkName rejects a name over 255 characters', () => {
  const result = checkName('a'.repeat(256))
  assert.equal(result.ok, false)
  assert.equal(result.problem, 'too_long')
  assert.equal(result.length, 256)
})

test('checkName accepts a name of exactly 255 characters', () => {
  assert.equal(checkName('a'.repeat(255)).ok, true)
})

test('checkName rejects a slash, backslash, and control characters', () => {
  assert.equal(checkName('a/b').problem, 'invalid_chars')
  assert.equal(checkName('a\\b').problem, 'invalid_chars')
  assert.equal(checkName('a\u0000b').problem, 'invalid_chars')
  assert.equal(checkName('a\u007fb').problem, 'invalid_chars')
})

test('nameProblemMessage formats every problem', () => {
  assert.equal(nameProblemMessage('empty', 0), '名字不能为空')
  assert.equal(nameProblemMessage('too_long', 256), '名字太长：最多 255 个字符，现在是 256 个')
  assert.equal(nameProblemMessage('invalid_chars', 3), '名字不能包含 / \\ 或控制字符')
})

test('normalizeName trims and normalizes NFC', () => {
  assert.equal(normalizeName('  café '), 'café')
})

test('sanitizeDisplayName falls back for control characters and replacement text', () => {
  assert.equal(sanitizeDisplayName('a\u0001b', 'file'), '未命名文件')
  assert.equal(sanitizeDisplayName('a\u0001b', 'directory'), '未命名文件夹')
  assert.equal(sanitizeDisplayName('ok.txt', 'file'), 'ok.txt')
})
