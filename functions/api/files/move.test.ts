import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type MoveRepository,
  type TrashRepository,
  type UploadRepository,
} from '../../_lib/file-repository.ts'
import type { MoveDriveClient } from '../../_lib/move-service.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'
import { createPatchHandler } from './[id].ts'

const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', role: 'user' as const, must_change_password: 0 }
const otherOwner = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', role: 'user' as const, must_change_password: 0 }
const fileId = '33333333-3333-4333-8333-333333333333'
const folderId = '44444444-4444-4444-8444-444444444444'
const childFolderId = '55555555-5555-4555-8555-555555555555'
const targetFolderId = '66666666-6666-4666-8666-666666666666'
const otherFileId = '77777777-7777-4777-8777-777777777777'

function authRepository(user = owner): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => ({ session_id: 'session', ...user }),
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

function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId,
    owner_id: owner.id,
    parent_id: null,
    kind: 'file',
    name: 'report.txt',
    name_key: 'report.txt',
    object_key: 'drive-file-1',
    size_bytes: 10,
    mime_type: 'text/plain',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
    drive_folder_id: null,
    md5: null,
    ...overrides,
  }
}

function folderRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: folderId,
    owner_id: owner.id,
    parent_id: null,
    kind: 'directory',
    name: 'Documents',
    name_key: 'documents',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'ready',
    drive_folder_id: null,
    md5: null,
    ...overrides,
  }
}

function makeRepository(initial: FileRecord[], options: { conflictOnUpdate?: boolean } = {}) {
  const files = initial.map((record) => ({ ...record }))
  const repository: MoveRepository & UploadRepository & TrashRepository = {
    findItem: async (ownerId, id) => files.find(
      (record) => record.owner_id === ownerId && record.id === id && !record.deleted_at,
    ) ?? null,
    isDescendantOrSelf: async (ownerId, ancestorId, candidateId) => {
      let currentId: string | null = candidateId
      while (currentId !== null) {
        if (currentId === ancestorId) return true
        const record = files.find(
          (candidate) => candidate.owner_id === ownerId && candidate.id === currentId && !candidate.deleted_at,
        )
        if (!record) return false
        currentId = record.parent_id
      }
      return false
    },
    updateNameAndParent: async (ownerId, id, name, nameKey, parentId, updatedAt) => {
      if (options.conflictOnUpdate) throw new FileRepositoryConflictError()
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId && candidate.id === id && !candidate.deleted_at,
      )
      if (!record) return null
      const clash = files.some(
        (candidate) => candidate.owner_id === ownerId
          && candidate.id !== id
          && !candidate.deleted_at
          && (candidate.parent_id ?? null) === parentId
          && candidate.name_key === nameKey
          && (candidate.kind === 'directory' || candidate.storage_status !== 'failed'),
      )
      if (clash) throw new FileRepositoryConflictError()
      record.name = name
      record.name_key = nameKey
      record.parent_id = parentId
      record.updated_at = updatedAt
      return { ...record }
    },
    findUserFolder: async (userId) => ({ id: userId, username: 'alice', drive_folder_id: 'user-folder' }),
    setUserFolderIfEmpty: async () => false,
    findDirectoryFolder: async (ownerId, id) => {
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId && candidate.id === id && candidate.kind === 'directory',
      )
      if (!record) return null
      return { id: record.id, name: record.name, parent_id: record.parent_id, drive_folder_id: record.drive_folder_id ?? null }
    },
    setDirectoryFolderIfEmpty: async () => false,
    createUploadSession: async () => undefined,
    findUploadSession: async () => null,
    updateUploadProgress: async () => false,
    deleteUploadSession: async () => undefined,
    updateCompletedFile: async () => null,
    markFileFailed: async () => null,
    listTrash: async () => [],
    findTrashFile: async () => null,
    hasActiveNameConflict: async (ownerId, parentId, nameKey) => files.some(
      (record) => record.owner_id === ownerId
        && !record.deleted_at
        && (record.parent_id ?? null) === parentId
        && record.name_key === nameKey
        && (record.kind === 'directory' || record.storage_status !== 'failed'),
    ),
    restoreFile: async () => null,
    deleteTrashedFile: async () => undefined,
    deleteExpiredTrash: async () => 0,
    listTrashObjectKeys: async () => [],
    countTrash: async () => 0,
  }
  return { repository, files }
}

function makeDriveClient(overrides: Partial<MoveDriveClient> = {}) {
  const updateCalls: Array<{ id: string; patch: { name?: string; addParents?: string; removeParents?: string } }> = []
  const parentQueries: string[] = []
  const createdFolders: Array<{ name: string; parentId: string }> = []
  const trashed: string[] = []
  const driveClient: MoveDriveClient = {
    createFolder: async (name, parentId) => {
      createdFolders.push({ name, parentId })
      return 'folder-1'
    },
    trash: async (id) => { trashed.push(id) },
    updateFile: async (id, patch) => { updateCalls.push({ id, patch }) },
    getParents: async (id) => {
      parentQueries.push(id)
      return ['old-parent']
    },
    ...overrides,
  }
  return { driveClient, updateCalls, parentQueries, createdFolders, trashed }
}

const storageRepository: StorageRepository = {
  getAccount: async () => ({
    id: 1,
    google_email: 'admin@example.com',
    refresh_token_ciphertext: 'ciphertext',
    refresh_token_iv: 'iv',
    root_folder_id: 'root-folder',
    connected_by: 'admin',
    status: 'active',
    quota_total: null,
    quota_used: null,
    quota_checked_at: null,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
  }),
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

function buildHandler(options: {
  files?: FileRecord[]
  conflictOnUpdate?: boolean
  user?: typeof owner
  driveClient?: Partial<MoveDriveClient>
} = {}) {
  const { repository, files } = makeRepository(options.files ?? [], { conflictOnUpdate: options.conflictOnUpdate })
  const { driveClient, updateCalls, parentQueries, createdFolders, trashed } = makeDriveClient(options.driveClient)
  const handler = createPatchHandler({
    createAuthRepository: () => authRepository(options.user ?? owner),
    createFileRepository: () => repository,
    createStorageRepository: () => storageRepository,
    createDriveClient: () => driveClient,
    fetchImpl: async () => new Response(null, { status: 500 }),
  })
  return { handler, files, repository, driveClient, updateCalls, parentQueries, createdFolders, trashed }
}

function env(): AuthEnv {
  return { DB: {} as D1Database }
}

function patchRequest(id: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://cloudhub.test/api/files/${id}`, {
    method: 'PATCH',
    headers: {
      Origin: 'https://cloudhub.test',
      'Content-Type': 'application/json',
      Cookie: 'cloudhub_session=move-test-token',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function run(handler: ReturnType<typeof createPatchHandler>, request: Request, environment: AuthEnv, id = fileId) {
  return handler({ request, env: environment, params: { id } } as never)
}

test('renames a file with a Drive PATCH and updates D1', async () => {
  const { handler, files, updateCalls } = buildHandler({ files: [fileRecord()] })
  const response = await run(handler, patchRequest(fileId, { name: 'renamed.txt' }), env())
  assert.equal(response.status, 200)
  const payload = await response.json() as { item: { name: string } }
  assert.equal(payload.item.name, 'renamed.txt')
  assert.deepEqual(updateCalls, [{ id: 'drive-file-1', patch: { name: 'renamed.txt' } }])
  assert.equal(files[0].name, 'renamed.txt')
  assert.equal(files[0].name_key, 'renamed.txt')
})

test('moves a file between folders and back to the root', async () => {
  const target = folderRecord({ id: targetFolderId, name: 'Target', name_key: 'target', drive_folder_id: 'target-folder' })
  const { handler, files, updateCalls, parentQueries } = buildHandler({
    files: [fileRecord({ parent_id: folderId }), target],
  })

  const response = await run(handler, patchRequest(fileId, { parentId: targetFolderId }), env())
  assert.equal(response.status, 200)
  assert.deepEqual(updateCalls, [{ id: 'drive-file-1', patch: { addParents: 'target-folder', removeParents: 'old-parent' } }])
  assert.deepEqual(parentQueries, ['drive-file-1'])
  assert.equal(files[0].parent_id, targetFolderId)

  updateCalls.length = 0
  parentQueries.length = 0
  const rootResponse = await run(handler, patchRequest(fileId, { parentId: null }), env())
  assert.equal(rootResponse.status, 200)
  assert.deepEqual(updateCalls, [{ id: 'drive-file-1', patch: { addParents: 'user-folder', removeParents: 'old-parent' } }])
  assert.equal(files[0].parent_id, null)
})

test('renames a folder without a Drive folder locally and with one via Drive', async () => {
  const local = buildHandler({ files: [folderRecord({ drive_folder_id: null })] })
  const localResponse = await run(local.handler, patchRequest(folderId, { name: 'Renamed' }), env(), folderId)
  assert.equal(localResponse.status, 200)
  assert.deepEqual(local.updateCalls, [])
  assert.equal(local.files[0].name, 'Renamed')

  const withDrive = buildHandler({ files: [folderRecord({ drive_folder_id: 'drive-folder' })] })
  const driveResponse = await run(withDrive.handler, patchRequest(folderId, { name: 'Renamed' }), env(), folderId)
  assert.equal(driveResponse.status, 200)
  assert.deepEqual(withDrive.updateCalls, [{ id: 'drive-folder', patch: { name: 'Renamed' } }])
})

test('renames and moves in a single Drive PATCH', async () => {
  const target = folderRecord({ id: targetFolderId, name: 'Target', name_key: 'target', drive_folder_id: 'target-folder' })
  const { handler, files, updateCalls } = buildHandler({ files: [fileRecord(), target] })
  const response = await run(handler, patchRequest(fileId, { name: 'new.txt', parentId: targetFolderId }), env())
  assert.equal(response.status, 200)
  assert.deepEqual(updateCalls, [{
    id: 'drive-file-1',
    patch: { name: 'new.txt', addParents: 'target-folder', removeParents: 'old-parent' },
  }])
  assert.equal(files[0].name, 'new.txt')
  assert.equal(files[0].parent_id, targetFolderId)
})

test('rejects moving a folder into its own descendant', async () => {
  const child = folderRecord({ id: childFolderId, name: 'Child', name_key: 'child', parent_id: folderId, drive_folder_id: 'child-folder' })
  const { handler, updateCalls } = buildHandler({ files: [folderRecord(), child] })
  const response = await run(handler, patchRequest(folderId, { parentId: childFolderId }), env(), folderId)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'invalid_move' })
  assert.deepEqual(updateCalls, [])
})

test('rejects a name conflict before touching Drive', async () => {
  const clash = fileRecord({ id: otherFileId, name: 'clash.txt', name_key: 'clash.txt' })
  const { handler, updateCalls } = buildHandler({ files: [fileRecord(), clash] })
  const response = await run(handler, patchRequest(fileId, { name: 'clash.txt' }), env())
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'conflict' })
  assert.deepEqual(updateCalls, [])
})

test('rolls back Drive when the D1 update hits the unique index', async () => {
  const { handler, files, updateCalls } = buildHandler({ files: [fileRecord()], conflictOnUpdate: true })
  const response = await run(handler, patchRequest(fileId, { name: 'renamed.txt' }), env())
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'conflict' })
  assert.deepEqual(updateCalls, [
    { id: 'drive-file-1', patch: { name: 'renamed.txt' } },
    { id: 'drive-file-1', patch: { name: 'report.txt' } },
  ])
  assert.equal(files[0].name, 'report.txt')
})

test('returns the current record without Drive when nothing changes', async () => {
  const { handler, updateCalls, parentQueries } = buildHandler({ files: [fileRecord({ parent_id: folderId })] })
  const response = await run(handler, patchRequest(fileId, { name: 'report.txt', parentId: folderId }), env())
  assert.equal(response.status, 200)
  const payload = await response.json() as { item: { name: string; parent_id: string } }
  assert.equal(payload.item.name, 'report.txt')
  assert.equal(payload.item.parent_id, folderId)
  assert.deepEqual(updateCalls, [])
  assert.deepEqual(parentQueries, [])
})

test('rejects a file that is not ready', async () => {
  const { handler, updateCalls } = buildHandler({ files: [fileRecord({ storage_status: 'pending' })] })
  const response = await run(handler, patchRequest(fileId, { name: 'x.txt' }), env())
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'not_ready' })
  assert.deepEqual(updateCalls, [])
})

test('hides foreign files and rejects cross-origin requests', async () => {
  const foreign = buildHandler({ files: [fileRecord({ owner_id: otherOwner.id })] })
  const foreignResponse = await run(foreign.handler, patchRequest(fileId, { name: 'x.txt' }), env())
  assert.equal(foreignResponse.status, 404)

  const cross = buildHandler({ files: [fileRecord()] })
  const crossResponse = await run(cross.handler, patchRequest(fileId, { name: 'x.txt' }, { Origin: 'https://attacker.test' }), env())
  assert.equal(crossResponse.status, 403)
  assert.deepEqual(await crossResponse.json(), { error: 'forbidden' })
})

test('rejects invalid names', async () => {
  const { handler, updateCalls } = buildHandler({ files: [fileRecord()] })
  const response = await run(handler, patchRequest(fileId, { name: 'a/b' }), env())
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_name' })
  assert.deepEqual(updateCalls, [])
})

test('rejects a missing or non-directory target parent', async () => {
  const missing = buildHandler({ files: [fileRecord()] })
  const missingResponse = await run(missing.handler, patchRequest(fileId, { parentId: targetFolderId }), env())
  assert.equal(missingResponse.status, 404)
  assert.deepEqual(await missingResponse.json(), { error: 'not_found' })

  const notDirectory = buildHandler({ files: [fileRecord(), fileRecord({ id: targetFolderId, name: 'f.txt', name_key: 'f.txt' })] })
  const notDirectoryResponse = await run(notDirectory.handler, patchRequest(fileId, { parentId: targetFolderId }), env())
  assert.equal(notDirectoryResponse.status, 404)
})

test('rejects an empty or malformed body', async () => {
  const { handler } = buildHandler({ files: [fileRecord()] })
  const empty = await run(handler, patchRequest(fileId, {}), env())
  assert.equal(empty.status, 400)
  assert.deepEqual(await empty.json(), { error: 'invalid_request' })

  const badParent = await run(handler, patchRequest(fileId, { parentId: 42 }), env())
  assert.equal(badParent.status, 400)
  assert.deepEqual(await badParent.json(), { error: 'invalid_request' })
})
