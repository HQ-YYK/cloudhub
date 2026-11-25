import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoveryCodeText } from './recovery-code.ts'

test('recoveryCodeText includes username, date, code and usage note', () => {
  const text = recoveryCodeText('alice', 'ABCD-EFGH-IJKL-MNOP', new Date('2026-11-25T00:00:00.000Z'))
  assert.ok(text.includes('alice'))
  assert.ok(text.includes('2026-11-25'))
  assert.ok(text.includes('ABCD-EFGH-IJKL-MNOP'))
  assert.ok(text.includes('恢复码是忘记密码后找回文件的唯一方式'))
})
