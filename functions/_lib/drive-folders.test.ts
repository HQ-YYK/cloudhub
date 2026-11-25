import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureDriveFolder, type DriveFolderClient } from './drive-folders.ts'
import type { UploadRepository } from './file-repository.ts'
import type { StorageRepository } from './storage-repository.ts'

const ownerId = '11111111-1111-4111-8111-111111111111'

interface UserFolder {
  id: string
  username: string
  drive_folder_id: string | null
}

interface DirectoryFolder {
  id: string
  name: string
  parent_id: string | null
  drive_folder_id: string | null
}

function uploadRepository(options: {
  user?: UserFolder
  setUserResult?: boolean
  directories?: Record<string, DirectoryFolder>
  setDirectoryResult?: boolean
} = {}) {
  const user = options.user ?? { id: ownerId, username: 'alice', drive_folder_id: null }
  const directories = { ...options.directories }
  let userReads = 0
  const repository: UploadRepository = {
    findUserFolder: async () => {
      userReads += 1
      if (options.setUserResult === false && userReads > 1) {
        return { ...user, drive_folder_id: 'existing-user-folder' }
      }
      return { ...user }
    },
    setUserFolderIfEmpty: async (_userId, folderId) => {
      if (options.setUserResult === false) return false
      if (user.drive_folder_id === null) {
        user.drive_folder_id = folderId
        return true
      }
      return false
    },
    findDirectoryFolder: async (_ownerId, id) => directories[id] ?? null,
    setDirectoryFolderIfEmpty: async (_ownerId, id, folderId) => {
      if (options.setDirectoryResult === false) return false
      const directory = directories[id]
      if (!directory || directory.drive_folder_id !== null) return false
      directory.drive_folder_id = folderId
      return true
    },
    createUploadSession: async () => undefined,
    findUploadSession: async () => null,
    updateUploadProgress: async () => false,
    deleteUploadSession: async () => undefined,
    updateCompletedFile: async () => null,
    markFileFailed: async () => null,
  }
  return { repository, user, directories }
}

function client() {
  const created: Array<{ name: string; parentId: string }> = []
  const trashed: string[] = []
  let next = 1
  const driveClient: DriveFolderClient = {
    async createFolder(name, parentId) {
      created.push({ name, parentId })
      return `folder-${next++}`
    },
    async trash(id) {
      trashed.push(id)
    },
  }
  return { driveClient, created, trashed }
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

test('creates the user folder under root once and reuses it', async () => {
  const { repository } = uploadRepository()
  const { driveClient, created } = client()

  const first = await ensureDriveFolder(driveClient, storageRepository, repository, ownerId, null)
  assert.equal(first, 'folder-1')
  assert.deepEqual(created, [{ name: 'alice', parentId: 'root-folder' }])

  const second = await ensureDriveFolder(driveClient, storageRepository, repository, ownerId, null)
  assert.equal(second, 'folder-1')
  assert.equal(created.length, 1)
})

test('creates nested directory folders on demand and persists each mapping', async () => {
  const directories = {
    parent: { id: 'parent', name: 'Parent', parent_id: null, drive_folder_id: null },
    child: { id: 'child', name: 'Child', parent_id: 'parent', drive_folder_id: null },
  }
  const { repository } = uploadRepository({ user: { id: ownerId, username: 'alice', drive_folder_id: 'user-folder' }, directories })
  const { driveClient, created } = client()

  const result = await ensureDriveFolder(driveClient, storageRepository, repository, ownerId, 'child')
  assert.equal(result, 'folder-2')
  assert.deepEqual(created, [
    { name: 'Parent', parentId: 'user-folder' },
    { name: 'Child', parentId: 'folder-1' },
  ])
  assert.equal(directories.parent.drive_folder_id, 'folder-1')
  assert.equal(directories.child.drive_folder_id, 'folder-2')
})

test('trashes the extra folder when a concurrent write wins', async () => {
  const { repository } = uploadRepository({ setUserResult: false })
  const { driveClient, trashed } = client()

  const result = await ensureDriveFolder(driveClient, storageRepository, repository, ownerId, null)
  assert.equal(result, 'existing-user-folder')
  assert.deepEqual(trashed, ['folder-1'])
})
