import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CryptoError,
  base64UrlEncode,
  base64UrlDecode,
  deriveFromPassword,
  generateMasterKey,
  generateKdfSalt,
  generateFileKey,
  wrapMasterKey,
  unwrapMasterKey,
  wrapFileKey,
  unwrapFileKey,
  exportFileKey,
  importFileKey,
  deriveFolderKey,
  deriveNameIndexKey,
  recoveryWrapKey,
  generateRecoveryKey,
  parseRecoveryCode,
  encryptFileMeta,
  decryptFileMeta,
  encryptFolderName,
  decryptFolderName,
  nameIndex,
  CIPHER_CHUNK_SIZE,
  PLAIN_CHUNK_SIZE,
  chunkCount,
  cipherSize,
  plainSizeFromCipher,
  encryptChunk,
  decryptChunk,
  cipherRangeForPlain,
} from './index.ts'

function isCode(code) {
  return (error) => error instanceof CryptoError && error.code === code
}

test('base64UrlEncode/Decode round-trips with no padding and url-safe alphabet', () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
  const encoded = base64UrlEncode(bytes)
  assert.ok(!encoded.includes('='), 'no padding')
  assert.ok(!encoded.includes('+') && !encoded.includes('/'), 'url-safe alphabet')
  assert.deepEqual(base64UrlDecode(encoded), bytes)
})

test('deriveFromPassword is deterministic and sensitive to password and salt', async () => {
  const saltA = generateKdfSalt()
  const saltB = generateKdfSalt()

  const first = await deriveFromPassword('correct horse battery', saltA, 1000)
  const second = await deriveFromPassword('correct horse battery', saltA, 1000)
  assert.equal(first.authKey, second.authKey)

  const otherSalt = await deriveFromPassword('correct horse battery', saltB, 1000)
  assert.notEqual(first.authKey, otherSalt.authKey)

  const otherPassword = await deriveFromPassword('correct horse battery!!', saltA, 1000)
  assert.notEqual(first.authKey, otherPassword.authKey)
})

test('wrapMasterKey round-trips and is bound to the userId AAD', async () => {
  const mk = generateMasterKey()
  const { wrapKey } = await deriveFromPassword('pw', generateKdfSalt(), 1000)

  const wrapped = await wrapMasterKey(mk, wrapKey, 'user-1')
  assert.deepEqual(await unwrapMasterKey(wrapped, wrapKey, 'user-1'), mk)

  await assert.rejects(unwrapMasterKey(wrapped, wrapKey, 'user-2'), isCode('decrypt_failed'))
})

test('a wrapKey cannot unwrap another account MK', async () => {
  const mk = generateMasterKey()
  const alice = await deriveFromPassword('same-password', generateKdfSalt(), 1000)
  const bob = await deriveFromPassword('same-password', generateKdfSalt(), 1000)

  const wrapped = await wrapMasterKey(mk, alice.wrapKey, 'user-1')
  await assert.rejects(unwrapMasterKey(wrapped, bob.wrapKey, 'user-1'), isCode('decrypt_failed'))
})

test('recovery code display has 13 groups of 4 and round-trips', () => {
  const { bytes, display } = generateRecoveryKey()
  const groups = display.split('-')
  assert.equal(groups.length, 13)
  for (const group of groups) assert.equal(group.length, 4)
  assert.deepEqual(parseRecoveryCode(display), bytes)
})

test('recovery code tolerates lowercase, spaces, and confusable letters', () => {
  const { bytes, display } = generateRecoveryKey()

  const messy = display.split('-').join(' ').toLowerCase()
  assert.deepEqual(parseRecoveryCode(messy), bytes)

  const swapped = display.replace(/0/gu, 'O').replace(/1/gu, 'I')
  assert.deepEqual(parseRecoveryCode(swapped), bytes)

  const withL = display.replace(/1/gu, 'L')
  assert.deepEqual(parseRecoveryCode(withL), bytes)
})

test('recovery code maps I/L to 1 and O to 0', () => {
  const oneThenZeros = new Uint8Array(32)
  oneThenZeros[0] = 0x80

  assert.deepEqual(parseRecoveryCode(`1${'0'.repeat(51)}`), oneThenZeros)
  assert.deepEqual(parseRecoveryCode(`I${'0'.repeat(51)}`), oneThenZeros)
  assert.deepEqual(parseRecoveryCode(`L${'0'.repeat(51)}`), oneThenZeros)
  assert.deepEqual(parseRecoveryCode(`O${'0'.repeat(51)}`), new Uint8Array(32))
})

test('recovery code rejects wrong length, U, and out-of-range values', () => {
  assert.throws(() => parseRecoveryCode('ABC'), isCode('invalid_recovery_code'))
  assert.throws(() => parseRecoveryCode('0'.repeat(53)), isCode('invalid_recovery_code'))
  assert.throws(() => parseRecoveryCode(`U${'0'.repeat(51)}`), isCode('invalid_recovery_code'))
  assert.throws(() => parseRecoveryCode('Z'.repeat(52)), isCode('invalid_recovery_code'))
})

test('recovery key wraps MK so it can be unwrapped', async () => {
  const mk = generateMasterKey()
  const { bytes } = generateRecoveryKey()
  const key = await recoveryWrapKey(bytes)

  const wrapped = await wrapMasterKey(mk, key, 'user-1')
  assert.deepEqual(await unwrapMasterKey(wrapped, key, 'user-1'), mk)
})

test('chunk size math and cipherSize/plainSizeFromCipher inverse', () => {
  assert.equal(chunkCount(0), 1)
  assert.equal(chunkCount(PLAIN_CHUNK_SIZE), 1)
  assert.equal(chunkCount(PLAIN_CHUNK_SIZE + 1), 2)

  assert.equal(cipherSize(0), 28)
  assert.equal(cipherSize(PLAIN_CHUNK_SIZE), CIPHER_CHUNK_SIZE)

  for (const size of [0, 1, 100, PLAIN_CHUNK_SIZE, PLAIN_CHUNK_SIZE + 1, PLAIN_CHUNK_SIZE * 3 + 42]) {
    assert.equal(plainSizeFromCipher(cipherSize(size)), size)
  }
})

test('plainSizeFromCipher rejects invalid sizes', () => {
  assert.throws(() => plainSizeFromCipher(0), isCode('invalid_size'))
  assert.throws(() => plainSizeFromCipher(27), isCode('invalid_size'))
  assert.throws(() => plainSizeFromCipher(-1), isCode('invalid_size'))
  assert.throws(() => plainSizeFromCipher(CIPHER_CHUNK_SIZE + 1), isCode('invalid_size'))
  assert.throws(() => plainSizeFromCipher(CIPHER_CHUNK_SIZE + 28), isCode('invalid_size'))
})

test('encryptChunk/decryptChunk round-trip with a 28-byte overhead', async () => {
  const fk = generateFileKey()
  const plain = new Uint8Array(100)
  crypto.getRandomValues(plain)

  const cipher = await encryptChunk(fk, 'file-1', 0, true, plain)
  assert.equal(cipher.length, plain.length + 28)
  assert.deepEqual(await decryptChunk(fk, 'file-1', 0, true, cipher), plain)
})

test('decryptChunk detects tampering and AAD changes', async () => {
  const fk = generateFileKey()
  const plain = new Uint8Array(64)
  crypto.getRandomValues(plain)

  const middle = await encryptChunk(fk, 'file-1', 0, false, plain)
  const flipped = middle.slice()
  flipped[5] ^= 0x01
  await assert.rejects(decryptChunk(fk, 'file-1', 0, false, flipped), isCode('decrypt_failed'))

  await assert.rejects(decryptChunk(fk, 'file-1', 1, false, middle), isCode('decrypt_failed'))
  await assert.rejects(decryptChunk(fk, 'file-2', 0, false, middle), isCode('decrypt_failed'))
  await assert.rejects(decryptChunk(fk, 'file-1', 0, true, middle), isCode('decrypt_failed'))

  const last = await encryptChunk(fk, 'file-1', 0, true, plain)
  await assert.rejects(decryptChunk(fk, 'file-1', 0, false, last), isCode('decrypt_failed'))
})

test('nameIndex is case-insensitive and parent-sensitive', async () => {
  const key = await deriveNameIndexKey(generateMasterKey())

  const upper = await nameIndex(key, 'parent-1', 'Report.PDF')
  const lower = await nameIndex(key, 'parent-1', 'report.pdf')
  assert.equal(upper, lower)

  const root = await nameIndex(key, null, 'report.pdf')
  assert.notEqual(upper, root)

  const otherParent = await nameIndex(key, 'parent-2', 'report.pdf')
  assert.notEqual(upper, otherParent)
})

test('file meta and folder name round-trip', async () => {
  const mk = generateMasterKey()
  const fk = generateFileKey()
  const folderKey = await deriveFolderKey(mk)

  const meta = { name: '报告.pdf', mimeType: 'application/pdf' }
  const metaCipher = await encryptFileMeta(fk, 'file-1', meta)
  assert.deepEqual(await decryptFileMeta(fk, 'file-1', metaCipher), meta)

  const nullMime = { name: 'note.txt', mimeType: null }
  const nullCipher = await encryptFileMeta(fk, 'file-1', nullMime)
  assert.deepEqual(await decryptFileMeta(fk, 'file-1', nullCipher), nullMime)

  const folderCipher = await encryptFolderName(folderKey, 'folder-1', '我的文档')
  assert.deepEqual(await decryptFolderName(folderKey, 'folder-1', folderCipher), { name: '我的文档' })
})

test('file meta and folder name are bound to AAD and key', async () => {
  const fk = generateFileKey()
  const otherFk = generateFileKey()
  const metaCipher = await encryptFileMeta(fk, 'file-1', { name: 'a.txt', mimeType: null })

  await assert.rejects(decryptFileMeta(fk, 'file-2', metaCipher), isCode('decrypt_failed'))
  await assert.rejects(decryptFileMeta(otherFk, 'file-1', metaCipher), isCode('decrypt_failed'))
})

test('cipherRangeForPlain within a chunk', () => {
  assert.deepEqual(cipherRangeForPlain(100, 200, PLAIN_CHUNK_SIZE), {
    firstChunk: 0,
    lastChunk: 0,
    cipherStart: 0,
    cipherEnd: CIPHER_CHUNK_SIZE,
  })
})

test('cipherRangeForPlain across chunks', () => {
  assert.deepEqual(cipherRangeForPlain(PLAIN_CHUNK_SIZE - 10, PLAIN_CHUNK_SIZE + 10, PLAIN_CHUNK_SIZE * 2), {
    firstChunk: 0,
    lastChunk: 1,
    cipherStart: 0,
    cipherEnd: CIPHER_CHUNK_SIZE * 2,
  })
})

test('cipherRangeForPlain last chunk boundary', () => {
  const plainSize = PLAIN_CHUNK_SIZE * 2 + 42
  assert.deepEqual(cipherRangeForPlain(PLAIN_CHUNK_SIZE * 2, plainSize, plainSize), {
    firstChunk: 2,
    lastChunk: 2,
    cipherStart: CIPHER_CHUNK_SIZE * 2,
    cipherEnd: CIPHER_CHUNK_SIZE * 2 + 42 + 28,
  })
})

test('cipherRangeForPlain rejects bad ranges', () => {
  assert.throws(() => cipherRangeForPlain(-1, 10, 100), isCode('invalid_input'))
  assert.throws(() => cipherRangeForPlain(50, 50, 100), isCode('invalid_input'))
  assert.throws(() => cipherRangeForPlain(0, 101, 100), isCode('invalid_input'))
})

test('importFileKey round-trips and validates 32 bytes', () => {
  const fk = generateFileKey()
  assert.deepEqual(importFileKey(exportFileKey(fk)), fk)
  assert.throws(() => importFileKey(base64UrlEncode(new Uint8Array(16))), isCode('invalid_input'))
})
