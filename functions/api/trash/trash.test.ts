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
    upsertAccount: async () => undefined,
    deleteAccount: async () => undefined,
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
      parent_name: parent?.name ?? null,
    }
  }

  function matches(record: FileRecord, ownerId: string, cutoff: string) {
    const deletedAt = record.deleted_at
    if (deletedAt === null) return false
    return record.owner_id === ownerId
      && record.kind === 'file'
      && (record.purged_at === null || record.purged_at === undefined)
      && deletedAt > cutoff
  }

  const repository: TrashRepository = {
    async listTrash(ownerId, cutoff) {
      return records
        .filter((record) => matches(record, ownerId, cutoff))
        .sort((a, b) => (a.deleted_at! < b.deleted_at! ? 1 : -1))
        .slice(0, 500)
        .map(toItem)
    },
    async findTrashFile(ownerId, id, cutoff) {
      const record = records.find((candidate) => candidate.id === id && matches(candidate, ownerId, cutoff))
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
    async deleteTrashedFile(ownerId, id) {
      const index = records.findIndex(
        (candidate) => candidate.id === id && candidate.owner_id === ownerId && candidate.deleted_at !== null,
      )
      if (index >= 0) records.splice(index, 1)
    },
    async deleteExpiredTrash(ownerId, cutoff) {
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record.owner_id === ownerId && record.kind === 'file' && record.deleted_at !== null && record.deleted_at <= cutoff) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
    async listTrashObjectKeys(ownerId, cutoff, limit) {
      return records
        .filter((record) => matches(record, ownerId, cutoff) && record.object_key !== null)
        .sort((a, b) => (a.deleted_at! < b.deleted_at! ? -1 : 1))
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key! }))
    },
    async countTrash(ownerId, cutoff) {
      return records.filter((record) => matches(record, ownerId, cutoff)).length
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
