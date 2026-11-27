import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlobStoreError } from '../../_lib/blob-store.ts'
import { createTrashItemHandler } from './[id]/index.ts'
import { createTrashHandler } from './index.ts'
import {
  buildOverrides,
  clearRequest,
  fileId,
  fileRecord,
  now,
  objectKey,
  otherOwner,
  purgeRequest,
  run,
  trashed,
  trashedFolder,
} from './trash.fixtures.ts'

test('purge one calls deletePermanently and deletes the row', async () => {
  const { overrides, records, deletedPermanently } = buildOverrides({ records: [trashed()] })
  const response = await run(createTrashItemHandler(overrides), purgeRequest(), { id: fileId })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: true })
  assert.deepEqual(deletedPermanently, [objectKey])
  assert.equal(records.some((record) => record.id === fileId), false)
})

test('purge one treats a Drive 404 as success', async () => {
  const { overrides, records, deleteErrors } = buildOverrides({ records: [trashed()] })
  deleteErrors.set(objectKey, new BlobStoreError('not_found', 'drive_object_not_found'))
  const response = await run(createTrashItemHandler(overrides), purgeRequest(), { id: fileId })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: true })
  assert.equal(records.some((record) => record.id === fileId), false)
})

test('purge one hides files owned by another user', async () => {
  const { overrides, deletedPermanently } = buildOverrides({ records: [trashed({ owner_id: otherOwner.id })] })
  const response = await run(createTrashItemHandler(overrides), purgeRequest(), { id: fileId })
  assert.equal(response.status, 404)
  assert.deepEqual(deletedPermanently, [])
})

test('clear purges at most 40 files and reports the remaining count', async () => {
  const records = Array.from({ length: 45 }, (_, index) => fileRecord({
    id: crypto.randomUUID(),
    object_key: `objects/file-${index}`,
    name: `file-${index}.txt`,
    name_key: `file-${index}.txt`,
    deleted_at: new Date(now.getTime() - (45 - index) * 60_000).toISOString(),
  }))
  const { overrides, deletedPermanently } = buildOverrides({ records })
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 40, remaining: 5 })
  assert.equal(deletedPermanently.length, 40)
})

test('clear stops at the first storage failure and keeps already-purged files', async () => {
  const records = Array.from({ length: 45 }, (_, index) => fileRecord({
    id: crypto.randomUUID(),
    object_key: `objects/file-${index}`,
    name: `file-${index}.txt`,
    name_key: `file-${index}.txt`,
    deleted_at: new Date(now.getTime() - (45 - index) * 60_000).toISOString(),
  }))
  const { overrides, deletedPermanently, deleteErrors } = buildOverrides({ records })
  deleteErrors.set('objects/file-2', new BlobStoreError('unavailable', 'drive_down'))
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 2, remaining: 43, error: 'storage_unavailable' })
  assert.deepEqual(deletedPermanently, ['objects/file-0', 'objects/file-1'])
})

test('purge folder deletes Drive files in batches and reports remaining', async () => {
  const folder = trashedFolder()
  const files = Array.from({ length: 45 }, (_, index) => fileRecord({
    id: crypto.randomUUID(),
    parent_id: folder.id,
    name: `f-${index}.txt`,
    name_key: `f-${index}.txt`,
    object_key: `objects/f-${index}`,
    deleted_at: folder.deleted_at,
  }))

  const { overrides, deletedPermanently, records } = buildOverrides({ records: [folder, ...files] })
  const response = await run(createTrashItemHandler(overrides), purgeRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 40, remaining: 5 })
  assert.equal(deletedPermanently.length, 40)
  assert.equal(records.some((record) => record.id === folder.id), true)
})

test('purge folder removes the D1 subtree once every Drive file is gone', async () => {
  const folder = trashedFolder()
  const child = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'a.txt', name_key: 'a.txt', object_key: 'objects/a', deleted_at: folder.deleted_at })

  const { overrides, records } = buildOverrides({ records: [folder, child] })
  const response = await run(createTrashItemHandler(overrides), purgeRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 1, remaining: 0 })
  assert.equal(records.some((record) => record.id === folder.id), false)
  assert.equal(records.some((record) => record.id === child.id), false)
})

test('clear removes folder rows once their files are purged', async () => {
  const folder = trashedFolder()
  const file = trashed({ id: crypto.randomUUID(), parent_id: folder.id, name: 'a.txt', name_key: 'a.txt', object_key: 'objects/a', deleted_at: folder.deleted_at })

  const { overrides, records } = buildOverrides({ records: [folder, file] })
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 1, remaining: 0 })
  assert.equal(records.length, 0)
})

test('purge one deletes a null-object_key file without calling Drive', async () => {
  const { overrides, records, deletedPermanently } = buildOverrides({
    records: [trashed({ object_key: null, storage_status: 'failed' })],
  })
  const response = await run(createTrashItemHandler(overrides), purgeRequest(), { id: fileId })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: true })
  assert.deepEqual(deletedPermanently, [])
  assert.equal(records.some((record) => record.id === fileId), false)
})

test('purge one reports storage_reauth_required on Drive auth failure', async () => {
  const { overrides, records, deleteErrors } = buildOverrides({ records: [trashed()] })
  deleteErrors.set(objectKey, new BlobStoreError('unavailable', 'storage_reauth_required'))
  const response = await run(createTrashItemHandler(overrides), purgeRequest(), { id: fileId })

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_reauth_required' })
  assert.equal(records.some((record) => record.id === fileId), true)
})

test('purge folder deletes null-object_key files without calling Drive', async () => {
  const folder = trashedFolder()
  const child = trashed({
    id: crypto.randomUUID(),
    parent_id: folder.id,
    name: 'a.txt',
    name_key: 'a.txt',
    object_key: null,
    storage_status: 'failed',
    deleted_at: folder.deleted_at,
  })

  const { overrides, deletedPermanently, records } = buildOverrides({ records: [folder, child] })
  const response = await run(createTrashItemHandler(overrides), purgeRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 1, remaining: 0 })
  assert.deepEqual(deletedPermanently, [])
  assert.equal(records.length, 0)
})

test('purge folder stops and reports storage_unavailable on Drive failure', async () => {
  const folder = trashedFolder()
  // The mock lists batch keys by id; sorted ids keep f-1 as the second file deleted.
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort()
  const files = Array.from({ length: 3 }, (_, index) => fileRecord({
    id: ids[index],
    parent_id: folder.id,
    name: `f-${index}.txt`,
    name_key: `f-${index}.txt`,
    object_key: `objects/f-${index}`,
    deleted_at: folder.deleted_at,
  }))

  const { overrides, deleteErrors, records } = buildOverrides({ records: [folder, ...files] })
  deleteErrors.set('objects/f-1', new BlobStoreError('unavailable', 'drive_down'))
  const response = await run(createTrashItemHandler(overrides), purgeRequest(folder.id), { id: folder.id })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 1, remaining: 2, error: 'storage_unavailable' })
  assert.equal(records.some((record) => record.id === folder.id), true)
})

test('clear deletes null-object_key files without calling Drive', async () => {
  const { overrides, deletedPermanently, records } = buildOverrides({
    records: [trashed({ object_key: null, storage_status: 'failed' })],
  })
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 1, remaining: 0 })
  assert.deepEqual(deletedPermanently, [])
  assert.equal(records.length, 0)
})

test('clear treats a Drive 404 as success', async () => {
  const { overrides, records, deleteErrors } = buildOverrides({ records: [trashed()] })
  deleteErrors.set(objectKey, new BlobStoreError('not_found', 'drive_object_not_found'))
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 1, remaining: 0 })
  assert.equal(records.length, 0)
})

test('clear reports storage_reauth_required when Drive authorization is gone', async () => {
  const { overrides, deleteErrors } = buildOverrides({ records: [trashed()] })
  deleteErrors.set(objectKey, new BlobStoreError('unavailable', 'storage_reauth_required'))
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 0, remaining: 1, error: 'storage_reauth_required' })
})

test('clear reports storage_not_connected when the account is gone', async () => {
  const { overrides, deleteErrors } = buildOverrides({ records: [trashed()] })
  deleteErrors.set(objectKey, new BlobStoreError('unavailable', 'storage_not_connected'))
  const response = await run(createTrashHandler(overrides), clearRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { purged: 0, remaining: 1, error: 'storage_not_connected' })
})
