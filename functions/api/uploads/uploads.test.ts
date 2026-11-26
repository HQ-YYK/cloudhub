import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import { BlobStoreError } from '../../_lib/blob-store.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type FileRepository,
  type UploadRepository,
  type UploadSession,
} from '../../_lib/file-repository.ts'
import { decryptSecret, encryptSecret } from '../../_lib/secret-box.ts'
import type { StorageAccount, StorageRepository } from '../../_lib/storage-repository.ts'
import type { UploadDriveClient } from '../../_lib/upload-service.ts'
import { createUploadChunkHandler } from './[id]/chunk.ts'
import { createUploadStatusHandler } from './[id]/index.ts'
import type { UploadDependencies } from './deps.ts'
import { createUploadHandler } from './index.ts'

const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', role: 'user' as const, must_change_password: 0 }
const otherOwner = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', role: 'user' as const, must_change_password: 0 }
const fileId = '33333333-3333-4333-8333-333333333333'
const key = Buffer.from('k'.repeat(32), 'ascii').toString('base64url')
const encName = 'A'.repeat(44)
const nameKey = 'A'.repeat(43)
const wrappedKey = 'A'.repeat(80)
const cipherSize = 28

function createBody(overrides: Record<string, unknown> = {}) {
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

function env() {
  return {
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    STORAGE_ENCRYPTION_KEY: key,
  }
}

function file(overrides: Partial<FileRecord> = {}): FileRecord {
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

function session(overrides: Partial<UploadSession> = {}): UploadSession {
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

function makeFileRepository(initialFiles: FileRecord[] = [], initialSessions: UploadSession[] = []) {
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

function makeDriveClient(overrides: Partial<UploadDriveClient> = {}) {
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

function activeAccount(): StorageAccount {
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

function buildOverrides(options: {
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

const sessionCookie = 'cloudhub_session=valid-token'

function postBody(body: unknown) {
  return new Request('https://cloudhub.test/api/uploads', {
    method: 'POST',
    headers: { Origin: 'https://cloudhub.test', 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body),
  })
}

function chunkRequest(uploadFileId: string, offset: number, body: Uint8Array) {
  return new Request(`https://cloudhub.test/api/uploads/${uploadFileId}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers: { Origin: 'https://cloudhub.test', Cookie: sessionCookie, 'Content-Length': String(body.byteLength) },
    body,
  })
}

async function encryptedSessionUri(uri: string) {
  return encryptSecret(uri, key)
}

test('create upload stores an encrypted session uri and hides it from responses', async () => {
  const { driveClient, resumeCalls } = makeDriveClient()
  const { overrides, files, sessions } = buildOverrides({ userFolder: 'user-folder', driveClient })
  const handler = createUploadHandler(overrides)
  const response = await handler({
    request: postBody(createBody()),
    env: env(),
    params: {},
  } as never)

  assert.equal(response.status, 201)
  const payload = await response.json() as { chunkSize: number, receivedBytes: number, uploadId: unknown }
  assert.equal(payload.chunkSize, 33554432)
  assert.equal(payload.receivedBytes, 0)
  assert.equal(typeof payload.uploadId, 'string')
  assert.ok(!JSON.stringify(payload).includes('session.example'))

  assert.equal(sessions.length, 1)
  assert.ok(!sessions[0].session_uri_ciphertext.includes('https://'))
  assert.ok(!sessions[0].session_uri_iv.includes('https://'))
  const decrypted = await decryptSecret(sessions[0].session_uri_ciphertext, sessions[0].session_uri_iv, key)
  assert.equal(decrypted, 'https://session.example/upload')

  assert.equal(files[0].storage_status, 'pending')
  assert.equal(files[0].enc, 1)
  assert.equal(files[0].wrapped_key, wrappedKey)
  assert.equal(resumeCalls.length, 1)
  assert.deepEqual(JSON.parse(String(resumeCalls[0].init?.body)), { name: fileId, parents: ['folder-1'] })
  const headers = resumeCalls[0].init?.headers as Record<string, string>
  assert.equal(headers['X-Upload-Content-Type'], 'application/octet-stream')
  assert.equal(headers['X-Upload-Content-Length'], String(cipherSize))
})

test('create upload rejects invalid cipher sizes', async () => {
  const { overrides } = buildOverrides()
  const handler = createUploadHandler(overrides)
  for (const size of [0, 27, 1.5, '28', 33554460]) {
    const response = await handler({
      request: postBody(createBody({ size })),
      env: env(),
      params: {},
    } as never)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_size' })
  }
})

test('create upload rejects plaintext names and invalid e2ee fields', async () => {
  const { overrides } = buildOverrides()
  const handler = createUploadHandler(overrides)
  for (const body of [
    createBody({ name: 'report.pdf' }),
    createBody({ encName: 'not base64!' }),
    createBody({ nameKey: 'short' }),
    createBody({ wrappedKey: 'short' }),
    createBody({ id: 'not-a-uuid' }),
  ]) {
    const response = await handler({
      request: postBody(body),
      env: env(),
      params: {},
    } as never)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_request' })
  }
})

test('create upload rejects a parent directory owned by another user', async () => {
  const foreign = file({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner_id: otherOwner.id, kind: 'directory', storage_status: 'ready', name: 'Other', wrapped_key: null })
  const { overrides } = buildOverrides({ files: [foreign] })
  const handler = createUploadHandler(overrides)
  const response = await handler({
    request: postBody(createBody({ parentId: foreign.id })),
    env: env(),
    params: {},
  } as never)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
})

test('create upload returns conflict for a duplicate active name', async () => {
  const existing = file({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: encName, name_key: nameKey })
  const { overrides } = buildOverrides({ files: [existing] })
  const handler = createUploadHandler(overrides)
  const response = await handler({
    request: postBody(createBody()),
    env: env(),
    params: {},
  } as never)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'conflict' })
})

test('create upload marks the file failed when the resumable session cannot start', async () => {
  const { driveClient } = makeDriveClient({ authorizedFetch: async () => new Response('{}', { status: 500 }) })
  const { overrides, files } = buildOverrides({ userFolder: 'user-folder', driveClient })
  const handler = createUploadHandler(overrides)
  const response = await handler({
    request: postBody(createBody()),
    env: env(),
    params: {},
  } as never)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_unavailable' })
  assert.equal(files[0].storage_status, 'failed')
})

test('create upload reports storage_not_connected and storage_not_configured', async () => {
  const notConnected = buildOverrides({ userFolder: null, storageAccount: null })
  let handler = createUploadHandler(notConnected.overrides)
  let response = await handler({
    request: postBody(createBody()),
    env: env(),
    params: {},
  } as never)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_not_connected' })
  assert.equal(notConnected.files.length, 0)

  const { driveClient } = makeDriveClient({
    authorizedFetch: async () => { throw new BlobStoreError('unavailable', 'storage_not_configured') },
  })
  const notConfigured = buildOverrides({ userFolder: 'user-folder', driveClient })
  handler = createUploadHandler(notConfigured.overrides)
  response = await handler({
    request: postBody(createBody()),
    env: env(),
    params: {},
  } as never)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'storage_not_configured' })
  assert.equal(notConfigured.files[0].storage_status, 'failed')
})

test('create upload rejects cross-origin writes before touching storage', async () => {
  const { overrides } = buildOverrides()
  const handler = createUploadHandler(overrides)
  const response = await handler({
    request: new Request('https://cloudhub.test/api/uploads', { method: 'POST', body: '{}' }),
    env: env(),
    params: {},
  } as never)
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'forbidden' })
})

test('chunk upload rejects an offset that does not match stored progress', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ received_bytes: 262144, session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response(null, { status: 500 })
  }
  const { overrides } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 0, new Uint8Array(262144)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'offset_mismatch', receivedBytes: 262144 })
  assert.equal(calls.length, 0)
})

test('chunk upload rejects a non-final chunk that is not 256 KiB aligned', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const { overrides } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession] })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 0, new Uint8Array(100)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_chunk' })
})

test('chunk upload parses the 308 Range header and updates progress', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } })
  }
  const { overrides, sessions } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 0, new Uint8Array(262144)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { receivedBytes: 262144, done: false })
  assert.equal(calls[0].init?.redirect, 'manual')
  assert.deepEqual(calls[0].init?.headers as Record<string, string>, {
    'Content-Length': '262144',
    'Content-Range': 'bytes 0-262143/524288',
  })
  assert.equal(sessions[0].received_bytes, 262144)
})

test('chunk upload finalizes the file on the last chunk', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ received_bytes: 262144, session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const fetchImpl = async () => new Response(
    JSON.stringify({ id: 'drive-file-1', size: '524288', md5Checksum: 'abc123' }),
    { status: 200 },
  )
  const { overrides, files, sessions } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 262144, new Uint8Array(262144)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 200)
  const payload = await response.json() as { receivedBytes: number, done: boolean, item: { id: string } }
  assert.equal(payload.receivedBytes, 524288)
  assert.equal(payload.done, true)
  assert.equal(payload.item.id, fileId)
  assert.equal(files[0].storage_status, 'ready')
  assert.equal(files[0].object_key, 'drive-file-1')
  assert.equal(files[0].md5, 'abc123')
  assert.equal(sessions.length, 0)
})

test('chunk upload trashes the drive file and fails when the final size mismatches', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ received_bytes: 262144, session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const { driveClient, trashed } = makeDriveClient()
  const fetchImpl = async () => new Response(
    JSON.stringify({ id: 'drive-file-1', size: '999', md5Checksum: 'abc123' }),
    { status: 200 },
  )
  const { overrides, files } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl, driveClient })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 262144, new Uint8Array(262144)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 502)
  assert.deepEqual(trashed, ['drive-file-1'])
  assert.equal(files[0].storage_status, 'failed')
})

test('chunk upload returns upload_expired when the drive session is gone', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const fetchImpl = async () => new Response(null, { status: 404 })
  const { overrides, files } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 0, new Uint8Array(262144)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 410)
  assert.deepEqual(await response.json(), { error: 'upload_expired' })
  assert.equal(files[0].storage_status, 'failed')
})

test('chunk upload rejects an expired session and marks the file failed', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({
    expires_at: '2020-01-01T00:00:00.000Z',
    session_uri_ciphertext: encrypted.ciphertext,
    session_uri_iv: encrypted.iv,
  })
  const { overrides, files } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession] })
  const handler = createUploadChunkHandler(overrides)
  const response = await handler({
    request: chunkRequest(fileId, 0, new Uint8Array(262144)),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 410)
  assert.deepEqual(await response.json(), { error: 'upload_expired' })
  assert.equal(files[0].storage_status, 'failed')
})

test('progress query reconciles received bytes from drive', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } })
  }
  const { overrides, sessions } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl })
  const handler = createUploadStatusHandler(overrides)
  const response = await handler({
    request: new Request(`https://cloudhub.test/api/uploads/${fileId}`, { headers: { Cookie: sessionCookie } }),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { receivedBytes: 262144, total: 524288, done: false })
  assert.equal(calls[0].init?.redirect, 'manual')
  assert.deepEqual(calls[0].init?.headers as Record<string, string>, {
    'Content-Length': '0',
    'Content-Range': 'bytes */524288',
  })
  assert.equal(sessions[0].received_bytes, 262144)
})

test('cancel deletes the session and marks the file failed', async () => {
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const uploadSession = session({ session_uri_ciphertext: encrypted.ciphertext, session_uri_iv: encrypted.iv })
  let deleteCalls = 0
  const fetchImpl = async () => {
    deleteCalls += 1
    return new Response(null, { status: 200 })
  }
  const { overrides, files, sessions } = buildOverrides({ files: [file({ size_bytes: 524288 })], sessions: [uploadSession], fetchImpl })
  const handler = createUploadStatusHandler(overrides)
  const response = await handler({
    request: new Request(`https://cloudhub.test/api/uploads/${fileId}`, {
      method: 'DELETE',
      headers: { Origin: 'https://cloudhub.test', Cookie: sessionCookie },
    }),
    env: env(),
    params: { id: fileId },
  } as never)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(deleteCalls, 1)
  assert.equal(sessions.length, 0)
  assert.equal(files[0].storage_status, 'failed')
})

test('a foreign uploadId is hidden from progress, chunk, and cancel', async () => {
  const foreignFileId = '99999999-9999-4999-8999-999999999999'
  const encrypted = await encryptedSessionUri('https://session.example/chunk')
  const foreignSession = session({
    file_id: foreignFileId,
    owner_id: otherOwner.id,
    session_uri_ciphertext: encrypted.ciphertext,
    session_uri_iv: encrypted.iv,
  })
  const { overrides } = buildOverrides({
    files: [file({ id: foreignFileId, owner_id: otherOwner.id, size_bytes: 524288 })],
    sessions: [foreignSession],
  })

  const status = createUploadStatusHandler(overrides)
  const getResponse = await status({
    request: new Request(`https://cloudhub.test/api/uploads/${foreignFileId}`, { headers: { Cookie: sessionCookie } }),
    env: env(),
    params: { id: foreignFileId },
  } as never)
  assert.equal(getResponse.status, 404)

  const deleteResponse = await status({
    request: new Request(`https://cloudhub.test/api/uploads/${foreignFileId}`, {
      method: 'DELETE',
      headers: { Origin: 'https://cloudhub.test', Cookie: sessionCookie },
    }),
    env: env(),
    params: { id: foreignFileId },
  } as never)
  assert.equal(deleteResponse.status, 404)

  const chunk = createUploadChunkHandler(overrides)
  const chunkResponse = await chunk({
    request: chunkRequest(foreignFileId, 0, new Uint8Array(262144)),
    env: env(),
    params: { id: foreignFileId },
  } as never)
  assert.equal(chunkResponse.status, 404)
})
