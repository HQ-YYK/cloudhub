import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlobStoreError } from '../../_lib/blob-store.ts'
import { createTrashItemHandler } from './[id]/index.ts'
import { createTrashRestoreHandler } from './[id]/restore.ts'
import { createTrashHandler } from './index.ts'
import {
  buildOverrides,
  clearRequest,
  fileId,
  fileRecord,
  listRequest,
  objectKey,
  otherOwner,
  purgeRequest,
  restoreRequest,
  run,
  trashed,
  trashedFolder,
} from './trash.fixtures.ts'

test('list returns only own, recent, unpurged files with expires_at and parent_name', async () => {
  const parent = fileRecord({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'directory',
    name: 'Documents',
    name_key: 'documents',
    object_key: null,
    size_bytes: null,
    mime_type: null,
  })
  const first = trashed({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', parent_id: parent.id, name: 'a.txt', name_key: 'a.txt', object_key: 'objects/a', deleted_at: '2030-01-10T00:00:00.000Z' })
  const second = trashed({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'b.txt', name_key: 'b.txt', object_key: 'objects/b', deleted_at: '2030-01-05T00:00:00.000Z' })
  const foreign = trashed({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', owner_id: otherOwner.id, object_key: 'objects/c' })
  const expired = trashed({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', object_key: 'objects/d', deleted_at: '2029-12-01T00:00:00.000Z' })
  const purged = trashed({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', object_key: 'objects/e', deleted_at: '2030-01-09T00:00:00.000Z', purged_at: '2030-01-12T00:00:00.000Z' })

  const { overrides, records } = buildOverrides({ records: [parent, first, second, foreign, expired, purged] })
  const response = await run(createTrashHandler(overrides), listRequest())
  assert.equal(records.some((record) => record.id === expired.id), false)

  assert.equal(response.status, 200)
  const payload = await response.json() as { items: Array<{ id: string, parent_name: string | null, expires_at: string }> }
  assert.equal(payload.items.length, 2)
  assert.equal(payload.items[0].id, first.id)
  assert.equal(payload.items[0].parent_name, 'Documents')
  assert.equal(payload.items[0].expires_at, '2030-02-09T00:00:00.000Z')
  assert.equal(payload.items[1].id, second.id)
  assert.equal(payload.items[1].parent_name, null)
})

test('list requires authentication', async () => {
  const { overrides } = buildOverrides({ authenticated: false })
  const response = await run(createTrashHandler(overrides), listRequest())
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'unauthorized' })
})

test('restore moves the file back to ready with a cleared deleted_at', async () => {
  const { overrides, records, untrashed } = buildOverrides({ records: [trashed()] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(), { id: fileId })

  assert.equal(response.status, 200)
  const payload = await response.json() as { item: { id: string } }
  assert.equal(payload.item.id, fileId)
  assert.deepEqual(untrashed, [objectKey])
  assert.equal(records[0].deleted_at, null)
  assert.equal(records[0].storage_status, 'ready')
})

test('restore returns conflict for an active same-name sibling without touching Drive', async () => {
  const active = fileRecord({
    id: '99999999-9999-4999-8999-999999999999',
    name: 'file.txt',
    name_key: 'file.txt',
    object_key: 'objects/active',
    deleted_at: null,
    storage_status: 'ready',
  })
  const { overrides, untrashed } = buildOverrides({ records: [trashed(), active] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(), { id: fileId })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'conflict' })
  assert.deepEqual(untrashed, [])
})

test('restore returns purged and deletes the row when Drive returns 404', async () => {
  const { overrides, records, untrashError } = buildOverrides({ records: [trashed()] })
  untrashError.current = new BlobStoreError('not_found', 'drive_object_not_found')
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(), { id: fileId })

  assert.equal(response.status, 410)
  assert.deepEqual(await response.json(), { error: 'purged' })
  assert.equal(records.some((record) => record.id === fileId), false)
})

test('restore hides files owned by another user', async () => {
  const { overrides, untrashed } = buildOverrides({ records: [trashed({ owner_id: otherOwner.id })] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(), { id: fileId })
  assert.equal(response.status, 404)
  assert.deepEqual(untrashed, [])
})

test('cross-origin writes are rejected before touching storage', async () => {
  const { overrides, deletedPermanently, untrashed } = buildOverrides({ records: [trashed()] })

  const clear = await run(createTrashHandler(overrides), clearRequest('https://attacker.test'))
  const purge = await run(createTrashItemHandler(overrides), purgeRequest(fileId, 'https://attacker.test'))
  const restore = await run(createTrashRestoreHandler(overrides), restoreRequest(fileId, 'https://attacker.test'))

  assert.equal(clear.status, 403)
  assert.equal(purge.status, 403)
  assert.equal(restore.status, 403)
  assert.deepEqual(deletedPermanently, [])
  assert.deepEqual(untrashed, [])
})

test('list shows top-level deleted folders with item_count and hides their children', async () => {
  const folder = trashedFolder()
  const child = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'a.txt', name_key: 'a.txt', object_key: 'objects/a', deleted_at: folder.deleted_at })
  const sibling = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'b.txt', name_key: 'b.txt', object_key: 'objects/b', deleted_at: folder.deleted_at })

  const { overrides } = buildOverrides({ records: [folder, child, sibling] })
  const response = await run(createTrashHandler(overrides), listRequest())

  assert.equal(response.status, 200)
  const payload = await response.json() as { items: Array<{ id: string, kind: string, item_count?: number }> }
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].id, folder.id)
  assert.equal(payload.items[0].kind, 'directory')
  assert.equal(payload.items[0].item_count, 2)
})

test('restore folder restores the whole same-batch subtree', async () => {
  const folder = trashedFolder()
  const child = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'a.txt', name_key: 'a.txt', object_key: 'objects/a', storage_status: 'ready', deleted_at: folder.deleted_at })

  const { overrides, records } = buildOverrides({ records: [folder, child] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  const payload = await response.json() as { item: { id: string } }
  assert.equal(payload.item.id, folder.id)
  assert.equal(records.every((record) => record.deleted_at === null), true)
})

test('restore folder moves to root when its parent is already deleted', async () => {
  const parent = trashedFolder({ deleted_at: '2030-01-05T00:00:00.000Z' })
  const folder = trashedFolder({ parent_id: parent.id })

  const { overrides, records } = buildOverrides({ records: [parent, folder] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  assert.equal(records.find((record) => record.id === folder.id)?.parent_id, null)
})

test('restore folder returns conflict when the target parent has the same name', async () => {
  const active = fileRecord({
    id: crypto.randomUUID(),
    kind: 'directory',
    name: 'Docs',
    name_key: 'docs',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    storage_status: 'ready',
  })
  const folder = trashedFolder({ name: 'Docs', name_key: 'docs' })

  const { overrides, untrashed } = buildOverrides({ records: [active, folder] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'conflict' })
  assert.deepEqual(untrashed, [])
})

test('list permanently deletes Drive objects of expired files that were trashed with a folder', async () => {
  const folder = trashedFolder({ deleted_at: '2029-12-01T00:00:00.000Z' })
  const child = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'a.txt', name_key: 'a.txt', object_key: 'objects/a', storage_status: 'ready', deleted_at: folder.deleted_at })
  const single = trashed({ id: crypto.randomUUID(), name: 'b.txt', name_key: 'b.txt', object_key: 'objects/b', storage_status: 'deleting', deleted_at: '2029-12-01T00:00:00.000Z' })

  const { overrides, records, deletedPermanently } = buildOverrides({ records: [folder, child, single] })
  const response = await run(createTrashHandler(overrides), listRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(deletedPermanently, ['objects/a'])
  assert.equal(records.length, 0)
})

test('restore folder keeps failed files failed and leaves Drive-trashed files in the trash', async () => {
  const folder = trashedFolder()
  const failed = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'f.txt', name_key: 'f.txt', object_key: 'objects/f', storage_status: 'failed', deleted_at: folder.deleted_at })
  const single = trashed({ id: crypto.randomUUID(), name: 's.txt', name_key: 's.txt', object_key: 'objects/s', storage_status: 'deleting', deleted_at: folder.deleted_at })

  const { overrides, records } = buildOverrides({ records: [folder, failed, single] })
  const response = await run(createTrashRestoreHandler(overrides), restoreRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  assert.equal(records.find((record) => record.id === failed.id)?.storage_status, 'failed')
  assert.equal(records.find((record) => record.id === failed.id)?.deleted_at, null)
  assert.notEqual(records.find((record) => record.id === single.id)?.deleted_at, null)
})
