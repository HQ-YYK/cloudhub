import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type UploadRepository,
  type UploadSession,
} from '../../_lib/file-repository.ts'
import { encryptSecret } from '../../_lib/secret-box.ts'
import type { StorageAccount, StorageRepository } from '../../_lib/storage-repository.ts'
import type { UploadDriveClient } from '../../_lib/upload-service.ts'
import type { UploadDependencies } from './deps.ts'

export const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', role: 'user' as const, must_change_password: 0 }
export const otherOwner = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', role: 'user' as const, must_change_password: 0 }
export const fileId = '33333333-3333-4333-8333-333333333333'
export const key = Buffer.from('k'.repeat(32), 'ascii').toString('base64url')
export const encName = 'A'.repeat(44)
export const nameKey = 'A'.repeat(43)
export const wrappedKey = 'A'.repeat(80)
export const cipherSize = 28
export const sessionCookie = 'cloudhub_session=valid-token'

export function createBody(overrides: Record<string, unknown> = {}) {
  return {
    id: fileId,
    parentId: null,
    encName,
    nameKey,
    wrappedKey,
    size: cipherSize,
    ...overrides,
  }
}

export function authRepository(user = owner): AuthRepository {
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

export function env() {
  return {
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    STORAGE_ENCRYPTION_KEY: key,
  }
}

export function file(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId,
    owner_id: owner.id,
    parent_id: null,
    kind: 'file',
    name: 'upload.bin',
    name_key: 'upload.bin',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'pending',
    enc: 1,
    wrapped_key: wrappedKey,
    ...overrides,
  }
}

export function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    file_id: fileId,
    owner_id: owner.id,
    session_uri_ciphertext: 'ciphertext',
    session_uri_iv: 'iv',
    total_bytes: 524288,
    received_bytes: 0,
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-10T00:00:00.000Z',
    ...overrides,
  }
}

export function makeFileRepository(initialFiles: FileRecord[] = [], initialSessions: UploadSession[] = []) {
  const files: FileRecord[] = initialFiles.map((record) => ({ ...record }))
  const sessions: UploadSession[] = initialSessions.map((record) => ({ ...record }))
  const userFolders = new Map<string, string | null>()

  const repository: FileRepository & UploadRepository = {
    listChildren: async (ownerId, parentId) => files.filter(
      (record) => record.owner_id === ownerId && record.parent_id === parentId && !record.deleted_at,
    ),
    listVisibleChildren: async (ownerId, parentId) => files.filter(
      (record) => record.owner_id === ownerId
        && record.parent_id === parentId
        && !record.deleted_at
        && (record.kind === 'directory' || record.storage_status === 'ready'),
    ),
    findDirectory: async (ownerId, id) => files.find(
      (record) => record.owner_id === ownerId && record.id === id && record.kind === 'directory' && !record.deleted_at,
    ) ?? null,
    createDirectory: async () => { throw new Error('not_used') },
    findFile: async (ownerId, id) => files.find(
      (record) => record.owner_id === ownerId && record.id === id && record.kind === 'file' && !record.deleted_at,
    ) ?? null,
    createPendingFile: async (input) => {
      const clash = files.some(
        (record) => record.owner_id === input.ownerId
          && record.parent_id === input.parentId
          && record.name_key === input.nameKey
          && !record.deleted_at,
      )
      if (clash) throw new FileRepositoryConflictError()
      const record: FileRecord = {
        id: input.id,
        owner_id: input.ownerId,
        parent_id: input.parentId,
        kind: 'file',
        name: input.name,
        name_key: input.nameKey,
        object_key: input.objectKey,
        size_bytes: input.sizeBytes,
        mime_type: input.mimeType,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        deleted_at: null,
        storage_status: 'pending',
        enc: input.enc,
        wrapped_key: input.wrappedKey,
      }
      files.push(record)
      return record
    },
    updateFileStorageStatus: async (ownerId, id, from, to, updatedAt) => {
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId
          && candidate.id === id
          && candidate.kind === 'file'
          && candidate.storage_status === from
          && !candidate.deleted_at,
      )
      if (!record) return null
      record.storage_status = to
      record.updated_at = updatedAt
      return record
    },
    softDeleteFile: async () => null,
    findUserFolder: async (userId) => {
      const folderId = userFolders.get(userId)
      return { id: userId, username: 'alice', drive_folder_id: folderId === undefined ? null : folderId }
    },
    setUserFolderIfEmpty: async (userId, folderId) => {
      if (userFolders.has(userId)) return false
      userFolders.set(userId, folderId)
      return true
    },
    findDirectoryFolder: async (ownerId, id) => {
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId && candidate.id === id && candidate.kind === 'directory',
      )
      if (!record) return null
      return { id: record.id, name: record.name, parent_id: record.parent_id, drive_folder_id: record.drive_folder_id ?? null }
    },
    setDirectoryFolderIfEmpty: async (ownerId, id, folderId) => {
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId && candidate.id === id && candidate.kind === 'directory',
      )
      if (!record || record.drive_folder_id != null) return false
      record.drive_folder_id = folderId
      return true
    },
    createUploadSession: async (uploadSession) => { sessions.push({ ...uploadSession }) },
    findUploadSession: async (ownerId, uploadFileId) => sessions.find(
      (record) => record.file_id === uploadFileId && record.owner_id === ownerId,
    ) ?? null,
    updateUploadProgress: async (ownerId, uploadFileId, from, to, updatedAt) => {
      const record = sessions.find(
        (candidate) => candidate.file_id === uploadFileId && candidate.owner_id === ownerId && candidate.received_bytes === from,
      )
      if (!record) return false
      record.received_bytes = to
      record.updated_at = updatedAt
      return true
    },
    deleteUploadSession: async (ownerId, uploadFileId) => {
      const index = sessions.findIndex((record) => record.file_id === uploadFileId && record.owner_id === ownerId)
      if (index >= 0) sessions.splice(index, 1)
    },
    updateCompletedFile: async (ownerId, uploadFileId, objectKey, md5, updatedAt) => {
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId
          && candidate.id === uploadFileId
          && candidate.kind === 'file'
          && candidate.storage_status === 'pending'
          && !candidate.deleted_at,
      )
      if (!record) return null
      record.object_key = objectKey
      record.md5 = md5
      record.storage_status = 'ready'
      record.updated_at = updatedAt
      return record
    },
    markFileFailed: async (ownerId, uploadFileId, updatedAt) => {
      const record = files.find(
        (candidate) => candidate.owner_id === ownerId && candidate.id === uploadFileId && candidate.kind === 'file',
      )
      if (!record) return null
      record.storage_status = 'failed'
      record.updated_at = updatedAt
      return record
    },
  }
  return { repository, files, sessions, userFolders }
}

export function makeDriveClient(overrides: Partial<UploadDriveClient> = {}) {
  const createCalls: Array<{ name: string; parentId: string }> = []
  const trashed: string[] = []
  const resumeCalls: Array<{ input: string; init?: RequestInit }> = []
  const driveClient: UploadDriveClient = {
    createFolder: async (name, parentId) => {
      createCalls.push({ name, parentId })
      return 'folder-1'
    },
    trash: async (id) => { trashed.push(id) },
    authorizedFetch: async (input, init) => {
      resumeCalls.push({ input, init })
      return new Response(null, { status: 200, headers: { Location: 'https://session.example/upload' } })
    },
    ...overrides,
  }
  return { driveClient, createCalls, trashed, resumeCalls }
}

export function activeAccount(): StorageAccount {
  return {
    id: 1,
    google_email: 'test@example.com',
    refresh_token_ciphertext: 'ciphertext',
    refresh_token_iv: 'iv',
    root_folder_id: 'root-folder',
    connected_by: 'admin',
    status: 'active',
    quota_total: null,
    quota_used: null,
    quota_checked_at: '2030-01-01T00:00:00.000Z',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
  }
}

export function buildOverrides(options: {
  files?: FileRecord[]
  sessions?: UploadSession[]
  userFolder?: string | null
  storageAccount?: StorageAccount | null
  driveClient?: UploadDriveClient
  fetchImpl?: typeof fetch
} = {}) {
  const { repository, files, sessions, userFolders } = makeFileRepository(options.files ?? [], options.sessions ?? [])
  if (options.userFolder !== undefined) userFolders.set(owner.id, options.userFolder)

  const account = options.storageAccount === undefined ? activeAccount() : options.storageAccount
  const storageRepository: StorageRepository = {
    getAccount: async () => account,
    listAccounts: async () => (account ? [account] : []),
    listAccountsWithStats: async () => [],
    countAccounts: async () => (account ? 1 : 0),
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
    setUserFolderIfEmpty: async () => true,
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async () => undefined,
    consumeOAuthState: async () => null,
    findAdminUserById: async () => null,
  }

  const overrides: Partial<UploadDependencies> = {
    createAuthRepository: () => authRepository(),
    createFileRepository: () => repository,
    createStorageRepository: () => storageRepository,
    createDriveClient: () => options.driveClient ?? makeDriveClient().driveClient,
    fetchImpl: options.fetchImpl ?? (async () => new Response(null, { status: 500 })),
    createFixedLengthStream: () => new TransformStream(),
  }
  return { overrides, files, sessions, userFolders }
}

export function postBody(body: unknown) {
  return new Request('https://cloudhub.test/api/uploads', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body),
  })
}

export function chunkRequest(uploadFileId: string, offset: number, body: Uint8Array) {
  return new Request(`https://cloudhub.test/api/uploads/${uploadFileId}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers: { Origin: 'https://cloudhub.test', Cookie: sessionCookie, 'Content-Length': String(body.byteLength) },
    body,
  })
}

export async function encryptedSessionUri(uri: string) {
  return encryptSecret(uri, key)
}
