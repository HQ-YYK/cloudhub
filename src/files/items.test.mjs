import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveFolderKey,
  encryptFileMeta,
  encryptFolderName,
  generateFileKey,
  generateMasterKey,
  wrapFileKey,
} from '../crypto/index.ts'
import { DECRYPT_FAILED_NAME, resolveDisplayName, resolveDriveItems } from './session.ts'

function item(overrides = {}) {
  return {
    id: 'f1',
    parent_id: null,
    kind: 'file',
    name: 'plain.txt',
    size_bytes: 100,
    mime_type: 'text/plain',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    enc: 0,
    wrappedKey: null,
    ...overrides,
  }
}

test('resolveDisplayName returns the plain name for enc 0', async () => {
  const result = await resolveDisplayName(generateMasterKey(), item({ name: 'hello.txt' }))
  assert.equal(result.name, 'hello.txt')
  assert.equal(result.status, 'plain')
})

test('resolveDisplayName decrypts a file name for enc 1', async () => {
  const mk = generateMasterKey()
  const fk = generateFileKey()
  const encName = await encryptFileMeta(fk, 'f1', { name: 'secret.pdf', mimeType: 'application/pdf' })
  const wrappedKey = await wrapFileKey(fk, mk, 'f1')
  const result = await resolveDisplayName(mk, item({ enc: 1, name: encName, wrappedKey }))
  assert.equal(result.name, 'secret.pdf')
  assert.equal(result.status, 'encrypted')
})

test('resolveDisplayName decrypts a directory name for enc 1', async () => {
  const mk = generateMasterKey()
  const folderKey = await deriveFolderKey(mk)
  const encName = await encryptFolderName(folderKey, 'd1', '我的文件夹')
  const result = await resolveDisplayName(mk, item({ id: 'd1', kind: 'directory', enc: 1, name: encName }))
  assert.equal(result.name, '我的文件夹')
  assert.equal(result.status, 'encrypted')
})

test('resolveDisplayName returns the failed name when a file has no wrapped key', async () => {
  const result = await resolveDisplayName(generateMasterKey(), item({ enc: 1, name: 'x', wrappedKey: null }))
  assert.equal(result.name, DECRYPT_FAILED_NAME)
  assert.equal(result.status, 'failed')
})

test('resolveDisplayName returns the failed name when decryption fails', async () => {
  const result = await resolveDisplayName(generateMasterKey(), item({ enc: 1, name: 'garbage', wrappedKey: 'garbage' }))
  assert.equal(result.name, DECRYPT_FAILED_NAME)
  assert.equal(result.status, 'failed')
})

test('resolveDriveItems sorts directories first, then by name', async () => {
  const mk = generateMasterKey()
  const items = [
    item({ id: 'f1', kind: 'file', name: 'b.txt' }),
    item({ id: 'd1', kind: 'directory', name: 'z' }),
    item({ id: 'f2', kind: 'file', name: 'a.txt' }),
    item({ id: 'd2', kind: 'directory', name: 'a' }),
  ]
  const resolved = await resolveDriveItems(mk, items)
  assert.deepEqual(resolved.map((entry) => entry.item.id), ['d2', 'd1', 'f2', 'f1'])
})
