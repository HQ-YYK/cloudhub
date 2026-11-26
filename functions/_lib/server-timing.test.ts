import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServerTiming } from './server-timing.ts'

test('server timing reports per-segment durations and a total', () => {
  let now = 0
  const timer = createServerTiming(() => now)

  now = 12
  timer.mark('auth')
  now = 34
  timer.mark('db')
  now = 50

  assert.equal(timer.header(), 'auth;dur=12, db;dur=22, total;dur=50')
})

test('server timing header has only the total before any mark', () => {
  assert.equal(createServerTiming(() => 0).header(), 'total;dur=0')
})

test('server timing never reports negative durations', () => {
  let now = 100
  const timer = createServerTiming(() => now)
  now = 90
  timer.mark('auth')
  assert.equal(timer.header(), 'auth;dur=0, total;dur=0')
})
