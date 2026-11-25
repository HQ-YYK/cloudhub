import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateInitialPassword } from './initial-password.ts'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

test('generateInitialPassword returns 8 characters from the allowed set', () => {
  for (let index = 0; index < 200; index += 1) {
    const password = generateInitialPassword()
    assert.equal(password.length, 8)
    for (const character of password) {
      assert.ok(ALPHABET.includes(character), `unexpected character ${character}`)
    }
  }
})
