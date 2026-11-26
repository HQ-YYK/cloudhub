import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldDeleteDeviceRecord } from './device-keys.ts'

test('shouldDeleteDeviceRecord keeps a record for the same user', () => {
  assert.equal(shouldDeleteDeviceRecord('u1', 'u1'), false)
})

test('shouldDeleteDeviceRecord deletes a record for a different user', () => {
  assert.equal(shouldDeleteDeviceRecord('u1', 'u2'), true)
})

test('shouldDeleteDeviceRecord keeps nothing when there is no record', () => {
  assert.equal(shouldDeleteDeviceRecord(null, 'u2'), false)
})

test('shouldDeleteDeviceRecord deletes a record when the current user is null', () => {
  assert.equal(shouldDeleteDeviceRecord('u1', null), true)
})
