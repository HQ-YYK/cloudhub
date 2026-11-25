import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authScreen } from './screen.ts'

function user(overrides = {}) {
  return {
    id: '1',
    username: 'alice',
    role: 'user',
    mustChangePassword: false,
    legacy: false,
    keysReady: true,
    ...overrides,
  }
}

test('authScreen routes by status and user state', () => {
  assert.equal(authScreen('loading', null, null), 'loading')
  assert.equal(authScreen('anonymous', null, null), 'login')
  assert.equal(authScreen('authenticated', null, null), 'login')
  assert.equal(authScreen('authenticated', user({ legacy: true }), null), 'setup')
  assert.equal(authScreen('authenticated', user({ keysReady: false }), null), 'setup')
  assert.equal(authScreen('authenticated', user({ mustChangePassword: true }), null), 'recovery')
  assert.equal(authScreen('authenticated', user(), null), 'unlock')
  assert.equal(authScreen('authenticated', user(), new Uint8Array(32)), 'workspace')
})
