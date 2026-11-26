import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPlatformResponse,
  platformErrorMessage,
  PLATFORM_LIMIT_MESSAGE,
  PLATFORM_UNAVAILABLE_MESSAGE,
} from './service-limits.ts'

test('classifyPlatformResponse maps a 429 non-JSON response to platform_limited', () => {
  assert.equal(classifyPlatformResponse(429, 'text/html'), 'platform_limited')
})

test('classifyPlatformResponse maps a 5xx non-JSON response to platform_unavailable', () => {
  assert.equal(classifyPlatformResponse(502, 'text/html'), 'platform_unavailable')
})

test('classifyPlatformResponse ignores JSON responses', () => {
  assert.equal(classifyPlatformResponse(429, 'application/json'), null)
  assert.equal(classifyPlatformResponse(502, 'application/json; charset=utf-8'), null)
})

test('classifyPlatformResponse ignores successful non-JSON responses', () => {
  assert.equal(classifyPlatformResponse(200, 'text/html'), null)
})

test('platformErrorMessage returns null for ordinary errors', () => {
  assert.equal(platformErrorMessage(new Error('boom')), null)
  assert.equal(platformErrorMessage({ code: 'invalid_response' }), null)
  assert.equal(platformErrorMessage(null), null)
})

test('platformErrorMessage returns the matching message', () => {
  assert.equal(platformErrorMessage({ code: 'platform_limited' }), PLATFORM_LIMIT_MESSAGE)
  assert.equal(platformErrorMessage({ code: 'platform_unavailable' }), PLATFORM_UNAVAILABLE_MESSAGE)
})
