import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import type {
  FileRecord,
  FileRepository,
  FolderDeleteRepository,
} from '../../_lib/file-repository.ts'
import { createDeleteHandler } from './[id].ts'

const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

function authRepository(authenticated = true, userId = ownerId): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => authenticated
      ? { session_id: 'session', id: userId, username: 'alice', role: 'user', must_change_password: 0 }
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

function record(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    owner_id: ownerId,
    parent_id: null,
    kind: 'file',
    name: 'file.txt',
    name_key: 'file.txt',
    object_key: 'objects/file',
    size_bytes: 4,
    mime_type: 'text/plain',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
    ...overrides,
  }
}

function directory(overrides: Partial<FileRecord> = {}): FileRecord {
  return record({
    kind: 'directory',
    name: 'Folder',
    name_key: 'folder',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    ...overrides,
  })
}

class TreeRepository implements FileRepository, FolderDeleteRepository {
  readonly records: FileRecord[]

  constructor(records: FileRecord[]) {
    this.records = records.map((item) => ({ ...item }))
  }

  private descendantIds(ownerIdValue: string, id: string): string[] {
    const result: string[] = []
    const queue = [id]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const candidate of this.records) {
        if (candidate.owner_id === ownerIdValue && candidate.parent_id === current && candidate.deleted_at === null) {
          result.push(candidate.id)
          queue.push(candidate.id)
        }
      }
    }
    return result
  }

  listChildren = async () => []
  listVisibleChildren = async () => []
  findDirectory = async (ownerIdValue: string, id: string) => (
    this.records.find((item) => item.owner_id === ownerIdValue && item.id === id && item.kind === 'directory' && item.deleted_at === null) ?? null
  )
  createDirectory = async () => {
    throw new Error('not_used')
  }
  findFile = async (ownerIdValue: string, id: string) => (
    this.records.find((item) => item.owner_id === ownerIdValue && item.id === id && item.kind === 'file' && item.deleted_at === null) ?? null
  )
  createPendingFile = async () => {
    throw new Error('not_used')
  }
  updateFileStorageStatus = async () => null
  softDeleteFile = async () => null

  countFolderDescendants = async (ownerIdValue: string, id: string) => this.descendantIds(ownerIdValue, id).length
  hasPendingDescendant = async (ownerIdValue: string, id: string) => this.descendantIds(ownerIdValue, id).some((descendantId) => {
    const item = this.records.find((candidate) => candidate.id === descendantId)
    return item?.kind === 'file' && item.storage_status === 'pending'
  })
  softDeleteFolderTree = async (ownerIdValue: string, id: string, deletedAt: string, updatedAt: string) => {
    const ids = new Set([id, ...this.descendantIds(ownerIdValue, id)])
    let count = 0
    for (const item of this.records) {
      if (item.owner_id === ownerIdValue && item.deleted_at === null && ids.has(item.id)) {
        item.deleted_at = deletedAt
        item.updated_at = updatedAt
        count += 1
      }
    }
    return count
  }
}

function request(id = '33333333-3333-4333-8333-333333333333') {
  return new Request(`https://cloudhub.test/api/files/${id}`, {
    method: 'DELETE',
    headers: {
      Origin: 'https://cloudhub.test',
      Cookie: 'cloudhub_session=valid-token',
    },
  })
}

function run(handler: ReturnType<typeof createDeleteHandler>, requestValue: Request, id: string) {
  return handler({ request: requestValue, env: { DB: {} as D1Database } satisfies AuthEnv, params: { id } } as never)
}

function setup(records: FileRecord[], userId = ownerId) {
  const repository = new TreeRepository(records)
  const onRequest = createDeleteHandler({
    createAuthRepository: () => authRepository(true, userId),
    createFileRepository: () => repository,
    createBlobStore: () => ({ put: async () => { throw new Error('not_used') }, get: async () => { throw new Error('not_used') }, head: async () => { throw new Error('not_used') }, delete: async () => undefined }),
  })
  return { onRequest, repository }
}

test('deleting a folder soft-deletes its whole subtree and leaves siblings and other owners alone', async () => {
  const folder = directory({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  const child = directory({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', parent_id: folder.id, name: 'Child', name_key: 'child' })
  const file = record({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', parent_id: child.id, name: 'a.txt', name_key: 'a.txt' })
  const rootFile = record({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', parent_id: folder.id, name: 'b.txt', name_key: 'b.txt' })
  const sibling = directory({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Sibling', name_key: 'sibling' })
  const foreign = directory({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', owner_id: otherOwnerId })

  const { onRequest, repository } = setup([folder, child, file, rootFile, sibling, foreign])
  const response = await run(onRequest, request(folder.id), folder.id)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { deleted: true, count: 4 })

  const deletedIds = [folder.id, child.id, file.id, rootFile.id]
  for (const item of repository.records) {
    if (deletedIds.includes(item.id)) {
      assert.equal(item.deleted_at, item.updated_at)
    } else {
      assert.equal(item.deleted_at, null)
    }
  }
  assert.equal(repository.records.find((item) => item.id === sibling.id)?.deleted_at, null)
  assert.equal(repository.records.find((item) => item.id === foreign.id)?.deleted_at, null)
})

test('folder with a pending descendant returns 409 folder_busy and changes nothing', async () => {
  const folder = directory({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  const pending = record({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', parent_id: folder.id, storage_status: 'pending', object_key: null })

  const { onRequest, repository } = setup([folder, pending])
  const response = await run(onRequest, request(folder.id), folder.id)

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'folder_busy' })
  assert.ok(repository.records.every((item) => item.deleted_at === null))
})

test('folder with more than 5000 descendants returns 400 folder_too_large', async () => {
  const folder = directory({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  const files = Array.from({ length: 5001 }, (_, index) => record({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    parent_id: folder.id,
    name: `f-${index}.txt`,
    name_key: `f-${index}.txt`,
    object_key: `objects/f-${index}`,
  }))

  const { onRequest, repository } = setup([folder, ...files])
  const response = await run(onRequest, request(folder.id), folder.id)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'folder_too_large' })
  assert.ok(repository.records.every((item) => item.deleted_at === null))
})

test('deleting a missing or foreign folder returns 404', async () => {
  const foreign = directory({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner_id: otherOwnerId })
  const { onRequest } = setup([foreign])

  assert.equal((await run(onRequest, request(foreign.id), foreign.id)).status, 404)
  assert.equal((await run(onRequest, request('99999999-9999-4999-8999-999999999999'), '99999999-9999-4999-8999-999999999999')).status, 404)
})
