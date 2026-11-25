import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database, PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import { BlobStoreError } from '../../_lib/blob-store.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type TrashItem,
  type TrashRepository,
  type TrashTreeRepository,
} from '../../_lib/file-repository.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'
import type { TrashDriveClient } from '../../_lib/trash-service.ts'
import { createTrashItemHandler } from './[id]/index.ts'
import { createTrashRestoreHandler } from './[id]/restore.ts'
import type { TrashDependencies } from './deps.ts'
import { createTrashHandler } from './index.ts'

const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', role: 'user' as const, must_change_password: 0 }
const otherOwner = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', role: 'user' as const, must_change_password: 0 }
const fileId = '33333333-3333-4333-8333-333333333333'
const objectKey = `objects/${fileId}`
const now = new Date('2030-01-15T00:00:00.000Z')
const sessionCookie = 'cloudhub_session=valid-token'

function authRepository(user = owner, authenticated = true): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => authenticated
      ? { session_id: 'session', ...user }
      : null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async () => undefined,
  }
}

function storageRepository(): StorageRepository {
  return {
    getAccount: async () => null,
    listAccounts: async () => [],
    listAccountsWithStats: async () => [],
    countAccounts: async () => 0,
    findAccountByEmail: async () => null,
    createAccount: async () => { throw new Error('not_implemented') },
    updateAccountTokens: async () => null,
    setAccountStatus: async () => null,
    setAccountReauth: async () => undefined,
    setAccountQuota: async () => undefined,
    deleteAccount: async () => undefined,
    countFilesByAccount: async () => 0,
    pendingBytesByAccount: async () => 0,
    findUserFolder: async () => null,
    setUserFolderIfEmpty: async () => false,
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async () => undefined,
    consumeOAuthState: async () => null,
    findAdminUserById: async () => null,
  }
}

function env(): AuthEnv {
  return { DB: {} as D1Database }
}

function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId,
    owner_id: owner.id,
    parent_id: null,
    kind: 'file',
    name: 'file.txt',
    name_key: 'file.txt',
    object_key: objectKey,
    size_bytes: 4,
    mime_type: 'text/plain',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'deleting',
    purged_at: null,
    ...overrides,
  }
}

function makeTrashRepository(initial: FileRecord[] = []) {
  const records: FileRecord[] = initial.map((record) => ({ ...record }))

  function toItem(record: FileRecord): TrashItem {
    const parent = record.parent_id === null
      ? null
      : records.find((candidate) => candidate.id === record.parent_id && candidate.kind === 'directory')
    return {
      id: record.id,
      owner_id: record.owner_id,
      parent_id: record.parent_id,
      kind: record.kind,
      name: record.name,
      name_key: record.name_key,
      object_key: record.object_key,
      size_bytes: record.size_bytes,
      mime_type: record.mime_type,
      created_at: record.created_at,
      updated_at: record.updated_at,
      deleted_at: record.deleted_at!,
      storage_account_id: record.storage_account_id ?? null,
      parent_name: parent?.name ?? null,
      item_count: record.kind === 'directory'
        ? records.filter((candidate) => candidate.owner_id === record.owner_id
          && candidate.deleted_at === record.deleted_at
          && candidate.id !== record.id).length
        : null,
    }
  }

  function isTrashed(record: FileRecord, ownerId: string, cutoff: string) {
    return record.owner_id === ownerId
      && record.deleted_at !== null
      && (record.purged_at === null || record.purged_at === undefined)
      && record.deleted_at > cutoff
  }

  function topLevel(record: FileRecord) {
    if (record.parent_id === null) return true
    const parent = records.find((candidate) => candidate.id === record.parent_id && candidate.owner_id === record.owner_id)
    if (!parent) return true
    return parent.deleted_at === null || parent.deleted_at !== record.deleted_at
  }

  const repository: TrashRepository & TrashTreeRepository = {
    async listTrash(ownerId, cutoff) {
      return records
        .filter((record) => isTrashed(record, ownerId, cutoff) && topLevel(record))
        .sort((a, b) => (a.deleted_at! < b.deleted_at! ? 1 : -1))
        .slice(0, 500)
        .map(toItem)
    },
    async findTrashFile(ownerId, id, cutoff) {
      const record = records.find((candidate) => candidate.id === id && isTrashed(candidate, ownerId, cutoff))
      return record ? toItem(record) : null
    },
    async hasActiveNameConflict(ownerId, parentId, nameKey) {
      return records.some(
        (record) => record.owner_id === ownerId
          && (record.parent_id ?? '') === (parentId ?? '')
          && record.name_key === nameKey
          && record.deleted_at === null,
      )
    },
    async restoreFile(ownerId, id, updatedAt) {
      const record = records.find(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'file'
          && candidate.deleted_at !== null
          && (candidate.purged_at === null || candidate.purged_at === undefined),
      )
      if (!record) return null
      const clash = records.some(
        (candidate) => candidate.id !== id
          && candidate.owner_id === ownerId
          && (candidate.parent_id ?? '') === (record.parent_id ?? '')
          && candidate.name_key === record.name_key
          && candidate.deleted_at === null,
      )
      if (clash) throw new FileRepositoryConflictError()
      record.deleted_at = null
      record.storage_status = 'ready'
      record.updated_at = updatedAt
      return record
    },
    async findActiveDirectory(ownerId, id) {
      const record = records.find(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'directory'
          && candidate.deleted_at === null,
      )
      return record ? { id: record.id } : null
    },
    async restoreFolderTree(ownerId, id, deletedAt, targetParentId, updatedAt) {
      const folder = records.find(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'directory'
          && candidate.deleted_at === deletedAt,
      )
      if (!folder) return null
      for (const record of records) {
        if (record.owner_id !== ownerId || record.deleted_at !== deletedAt) continue
        if (record.kind === 'file' && record.storage_status === 'deleting') continue
        record.deleted_at = null
        record.updated_at = updatedAt
      }
      folder.parent_id = targetParentId
      return folder
    },
    async deleteTrashedFile(ownerId, id) {
      const index = records.findIndex(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'file'
          && candidate.deleted_at !== null,
      )
      if (index >= 0) records.splice(index, 1)
    },
    async deleteTrashedBatch(ownerId, deletedAt) {
      for (const record of records) {
        if (record.owner_id !== ownerId || record.deleted_at === deletedAt) continue
        const parent = records.find(
          (candidate) => candidate.owner_id === ownerId
            && candidate.deleted_at === deletedAt
            && candidate.id === record.parent_id,
        )
        if (parent) record.parent_id = null
      }
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record.owner_id === ownerId && record.deleted_at === deletedAt) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
    async deleteExpiredTrash(ownerId, cutoff) {
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        const live = record.kind === 'file' && record.object_key !== null && record.storage_status !== 'deleting'
        if (record.owner_id === ownerId && record.deleted_at !== null && record.deleted_at <= cutoff && !live) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
    async listExpiredLiveObjectKeys(ownerId, cutoff, limit) {
      return records
        .filter((record) => record.owner_id === ownerId
          && record.kind === 'file'
          && record.deleted_at !== null
          && record.deleted_at <= cutoff
          && record.storage_status !== 'deleting'
          && record.object_key !== null)
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key!, storage_account_id: record.storage_account_id ?? null }))
    },
    async listTrashObjectKeys(ownerId, cutoff, limit) {
      return records
        .filter((record) => isTrashed(record, ownerId, cutoff) && record.kind === 'file' && record.object_key !== null)
        .sort((a, b) => (a.deleted_at! < b.deleted_at! ? -1 : 1))
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key!, storage_account_id: record.storage_account_id ?? null }))
    },
    async countTrash(ownerId, cutoff) {
      return records.filter((record) => isTrashed(record, ownerId, cutoff) && record.kind === 'file').length
    },
    async listBatchObjectKeys(ownerId, deletedAt, limit) {
      return records
        .filter((record) => record.owner_id === ownerId
          && record.kind === 'file'
          && record.deleted_at === deletedAt
          && (record.purged_at === null || record.purged_at === undefined)
          && record.object_key !== null)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key!, storage_account_id: record.storage_account_id ?? null }))
    },
    async countBatchFiles(ownerId, deletedAt) {
      return records.filter((record) => record.owner_id === ownerId
        && record.kind === 'file'
        && record.deleted_at === deletedAt
        && (record.purged_at === null || record.purged_at === undefined)).length
    },
    async purgeEmptyTrashFolders(ownerId, cutoff) {
      const emptyBatches = new Set(
        records
          .filter((record) => record.owner_id === ownerId
            && record.kind === 'directory'
            && record.deleted_at !== null
            && (record.purged_at === null || record.purged_at === undefined)
            && record.deleted_at > cutoff)
          .filter((directory) => !records.some(
            (candidate) => candidate.owner_id === ownerId
              && candidate.kind === 'file'
              && candidate.deleted_at === directory.deleted_at
              && (candidate.purged_at === null || candidate.purged_at === undefined),
          ))
          .map((directory) => directory.deleted_at!),
      )
      for (const record of records) {
        if (record.owner_id !== ownerId || record.parent_id === null) continue
        const parent = records.find((candidate) => candidate.owner_id === ownerId && candidate.id === record.parent_id)
        if (parent && parent.deleted_at !== null && emptyBatches.has(parent.deleted_at)) record.parent_id = null
      }
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record.owner_id === ownerId && record.deleted_at !== null && emptyBatches.has(record.deleted_at)) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
  }
  return { repository, records }
}

function makeDriveClient() {
  const untrashed: string[] = []
  const deletedPermanently: string[] = []
  const reTrashed: string[] = []
  const deleteErrors = new Map<string, BlobStoreError>()
  const untrashError = { current: null as BlobStoreError | null }
  const client: TrashDriveClient = {
    async untrash(id) {
      if (untrashError.current) throw untrashError.current
      untrashed.push(id)
    },
    async deletePermanently(id) {
      const error = deleteErrors.get(id)
      if (error) throw error
      deletedPermanently.push(id)
    },
    async trash(id) {
      reTrashed.push(id)
    },
  }
  return { client, untrashed, deletedPermanently, reTrashed, deleteErrors, untrashError }
}

function buildOverrides(options: {
  records?: FileRecord[]
  user?: typeof owner
  authenticated?: boolean
} = {}) {
  const { repository, records } = makeTrashRepository(options.records ?? [])
  const drive = makeDriveClient()
  const overrides: Partial<TrashDependencies> = {
    createAuthRepository: () => authRepository(options.user, options.authenticated),
    createTrashRepository: () => repository,
    createStorageRepository: () => storageRepository(),
    createDriveClient: () => drive.client,
    fetchImpl: async () => new Response(null, { status: 500 }),
    now: () => now,
  }
  return { overrides, records, repository, ...drive }
}

function run(handler: PagesFunction<AuthEnv>, request: Request, params: Record<string, string> = {}) {
  return handler({ request, env: env(), params } as never)
}

function listRequest() {
  return new Request('https://cloudhub.test/api/trash', { headers: { Cookie: sessionCookie } })
}

function clearRequest(origin = 'https://cloudhub.test') {
  return new Request('https://cloudhub.test/api/trash', {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: sessionCookie },
  })
}

function purgeRequest(id = fileId, origin = 'https://cloudhub.test') {
  return new Request(`https://cloudhub.test/api/trash/${id}`, {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: sessionCookie },
  })
}

function restoreRequest(id = fileId, origin = 'https://cloudhub.test') {
  return new Request(`https://cloudhub.test/api/trash/${id}/restore`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: sessionCookie },
  })
}

function trashed(overrides: Partial<FileRecord> = {}) {
  return fileRecord({ deleted_at: '2030-01-10T00:00:00.000Z', ...overrides })
}

function trashedFolder(overrides: Partial<FileRecord> = {}) {
  return fileRecord({
    id: crypto.randomUUID(),
    kind: 'directory',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    storage_status: 'ready',
    deleted_at: '2030-01-10T00:00:00.000Z',
    ...overrides,
  })
}

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
  assert.deepEqual(await response.json(), { purged: 2, remaining: 43 })
  assert.deepEqual(deletedPermanently, ['objects/file-0', 'objects/file-1'])
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
