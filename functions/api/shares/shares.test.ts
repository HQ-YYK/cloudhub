import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { MockBlobStore } from '../../_lib/mock-blob-store.ts'
import { decryptSecret, encryptSecret } from '../../_lib/secret-box.ts'
import type {
  NewShare,
  ShareFileInfo,
  ShareRecord,
  ShareRepository,
  ShareWithFileRecord,
} from '../../_lib/share-repository.ts'
import {
  createShare,
  getPublicShareMetadata,
  listSharesByFile,
  revokeShare,
  ShareServiceError,
  streamPublicShare,
} from '../../_lib/share-service.ts'
import { createFileSharesHandler } from '../files/[id]/shares.ts'
import { createPublicShareDownloadHandler } from '../public/shares/[token]/download.ts'
import { createPublicShareMetadataHandler } from '../public/shares/[token]/index.ts'
import { createShareDeleteHandler } from './[id].ts'
import { createSharesIndexHandler } from './index.ts'

const owner = { id: 'owner-1', username: 'alice', role: 'user' as const, must_change_password: 0 }
const otherOwner = { id: 'owner-2', username: 'bob', role: 'user' as const, must_change_password: 0 }
const encryptionKey = Buffer.from('1'.repeat(32), 'ascii').toString('base64url')
const fileId = 'file-1'

interface StoredFile extends ShareFileInfo {
  owner_id: string
}

function authRepository(user: typeof owner | null = owner): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => user
      ? { session_id: 'session', id: user.id, username: user.username, role: user.role, must_change_password: user.must_change_password }
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

function shareFile(options: Partial<StoredFile> = {}): StoredFile {
  return {
    id: fileId,
    owner_id: owner.id,
    name: '报告.txt',
    size_bytes: 100,
    mime_type: 'text/plain',
    object_key: 'objects/file-1',
    deleted_at: null,
    storage_status: 'ready',
    kind: 'file',
    ...options,
  }
}

function shareRecord(options: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'share-1',
    owner_id: owner.id,
    file_id: fileId,
    token_hash: '0'.repeat(64),
    token_ciphertext: 'cipher',
    token_iv: 'iv',
    expires_at: null,
    revoked_at: null,
    download_count: 0,
    created_at: '2030-01-01T00:00:00.000Z',
    ...options,
  }
}

function toShareWithFile(share: ShareRecord, file: StoredFile): ShareWithFileRecord {
  return {
    ...share,
    file_name: file.name,
    file_size_bytes: file.size_bytes,
    file_mime_type: file.mime_type,
    file_object_key: file.object_key,
    file_deleted_at: file.deleted_at,
    file_storage_status: file.storage_status,
    file_kind: file.kind,
  }
}

function shareRepository(files: StoredFile[] = [], shares: ShareRecord[] = []) {
  const createdInputs: NewShare[] = []
  const incremented: string[] = []

  const repository: ShareRepository = {
    async create(input) {
      createdInputs.push(input)
      const record: ShareRecord = {
        id: input.id,
        owner_id: input.ownerId,
        file_id: input.fileId,
        token_hash: input.tokenHash,
        token_ciphertext: input.tokenCiphertext,
        token_iv: input.tokenIv,
        expires_at: input.expiresAt,
        revoked_at: null,
        download_count: 0,
        created_at: input.createdAt,
      }
      shares.push(record)
      return record
    },
    async findById(id, ownerIdValue) {
      return shares.find((share) => share.id === id && share.owner_id === ownerIdValue) ?? null
    },
    async findActiveByTokenHash(tokenHash, now) {
      const share = shares.find((candidate) => (
        candidate.token_hash === tokenHash
        && candidate.revoked_at === null
        && (candidate.expires_at === null || candidate.expires_at > now)
      ))
      if (!share) return null
      const file = files.find((candidate) => (
        candidate.id === share.file_id && candidate.owner_id === share.owner_id
      ))
      if (!file || file.deleted_at !== null || file.kind !== 'file' || file.storage_status !== 'ready') {
        return null
      }
      return toShareWithFile(share, file)
    },
    async findFileForShare(ownerIdValue, id) {
      const file = files.find((candidate) => candidate.id === id && candidate.owner_id === ownerIdValue)
      if (!file) return null
      return {
        id: file.id,
        name: file.name,
        size_bytes: file.size_bytes,
        mime_type: file.mime_type,
        object_key: file.object_key,
        deleted_at: file.deleted_at,
        storage_status: file.storage_status,
        kind: file.kind,
      }
    },
    async listByFile(ownerIdValue, id, limit) {
      return shares
        .filter((share) => share.owner_id === ownerIdValue && share.file_id === id)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((share) => toShareWithFile(
          share,
          files.find((file) => file.id === share.file_id && file.owner_id === share.owner_id)!,
        ))
    },
    async listByOwner(ownerIdValue, limit) {
      return shares
        .filter((share) => share.owner_id === ownerIdValue)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((share) => toShareWithFile(
          share,
          files.find((file) => file.id === share.file_id && file.owner_id === share.owner_id)!,
        ))
    },
    async countActiveByFile(ownerIdValue, id, now) {
      return shares.filter((share) => (
        share.owner_id === ownerIdValue
        && share.file_id === id
        && share.revoked_at === null
        && (share.expires_at === null || share.expires_at > now)
      )).length
    },
    async revoke(id, ownerIdValue, revokedAt) {
      const share = shares.find((candidate) => candidate.id === id && candidate.owner_id === ownerIdValue)
      if (share && share.revoked_at === null) share.revoked_at = revokedAt
    },
    async incrementDownloadCount(id) {
      incremented.push(id)
      const share = shares.find((candidate) => candidate.id === id)
      if (share) share.download_count += 1
    },
  }

  return { repository, files, shares, createdInputs, incremented }
}

function request(url: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { Cookie: 'cloudhub_session=session', ...headers },
  })
}

function handlerContext(
  onRequest: (context: never) => Promise<Response> | Response,
  req: Request,
  params: Record<string, string> = {},
) {
  const env = { DB: {} as D1Database, STORAGE_ENCRYPTION_KEY: encryptionKey } satisfies AuthEnv
  return onRequest({ request: req, env, params } as never)
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function makeToken(seed: number) {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function testToken() {
  return makeToken(1)
}

async function readBody(response: Response) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

test('createShare stores the hashed and encrypted token and returns the full url', async () => {
  const { repository, createdInputs } = shareRepository([shareFile()])
  const view = await createShare(
    authRepository(),
    repository,
    request('https://cloudhub.test/api/files/file-1/shares', 'POST'),
    fileId,
    7,
    encryptionKey,
  )

  assert.equal(view.fileId, fileId)
  assert.equal(view.fileName, '报告.txt')
  assert.match(view.url, /^https:\/\/cloudhub\.test\/s\/[A-Za-z0-9_-]{43}$/u)
  assert.equal(view.active, true)
  assert.equal(view.downloadCount, 0)

  assert.equal(createdInputs.length, 1)
  const stored = createdInputs[0]
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/u)
  assert.ok(stored.tokenCiphertext.length > 0)
  assert.ok(stored.tokenIv.length > 0)
  assert.notEqual(stored.tokenCiphertext, stored.tokenHash)

  const token = view.url.slice('https://cloudhub.test/s/'.length)
  assert.equal(await decryptSecret(stored.tokenCiphertext, stored.tokenIv, encryptionKey), token)
  assert.equal(await sha256Hex(token), stored.tokenHash)
})

test('createShare rejects invalid expiry values, foreign files, and too many active shares', async () => {
  for (const expiresInDays of [2, 0, -1, '7', true, undefined]) {
    const { repository } = shareRepository([shareFile()])
    await assert.rejects(
      createShare(authRepository(), repository, request('https://cloudhub.test/api/files/file-1/shares', 'POST'), fileId, expiresInDays, encryptionKey),
      (error: unknown) => error instanceof ShareServiceError && error.code === 'invalid_expires',
    )
  }

  const foreign = shareRepository([shareFile({ owner_id: otherOwner.id })])
  await assert.rejects(
    createShare(authRepository(), foreign.repository, request('https://cloudhub.test/api/files/file-1/shares', 'POST'), fileId, 7, encryptionKey),
    (error: unknown) => error instanceof ShareServiceError && error.code === 'not_found',
  )

  const full = shareRepository(
    [shareFile()],
    Array.from({ length: 20 }, (_, index) => shareRecord({ id: `share-${index}`, token_hash: `${index}`.padStart(64, '0') })),
  )
  await assert.rejects(
    createShare(authRepository(), full.repository, request('https://cloudhub.test/api/files/file-1/shares', 'POST'), fileId, 7, encryptionKey),
    (error: unknown) => error instanceof ShareServiceError && error.code === 'too_many_shares',
  )
})

test('createShare accepts a null expiry for a never-expiring link', async () => {
  const { repository } = shareRepository([shareFile()])
  const view = await createShare(
    authRepository(),
    repository,
    request('https://cloudhub.test/api/files/file-1/shares', 'POST'),
    fileId,
    null,
    encryptionKey,
  )
  assert.equal(view.expiresAt, null)
  assert.equal(view.active, true)
})

test('listSharesByFile returns shares including inactive ones and marks file state', async () => {
  const file = shareFile()
  const shares: ShareRecord[] = []
  const states = [
    { id: 'active', created_at: '2030-01-03T00:00:00.000Z' },
    { id: 'revoked', created_at: '2030-01-02T00:00:00.000Z', revoked_at: '2030-01-04T00:00:00.000Z' },
    { id: 'expired', created_at: '2030-01-01T00:00:00.000Z', expires_at: '2030-01-02T00:00:00.000Z' },
  ]
  for (let index = 0; index < states.length; index += 1) {
    const token = makeToken(index + 1)
    const encrypted = await encryptSecret(token, encryptionKey)
    shares.push(shareRecord({
      id: states[index].id,
      created_at: states[index].created_at,
      token_hash: await sha256Hex(token),
      token_ciphertext: encrypted.ciphertext,
      token_iv: encrypted.iv,
      ...(states[index].revoked_at ? { revoked_at: states[index].revoked_at } : {}),
      ...(states[index].expires_at ? { expires_at: states[index].expires_at } : {}),
    }))
  }
  const { repository } = shareRepository([file], shares)

  const views = await listSharesByFile(
    authRepository(),
    repository,
    request('https://cloudhub.test/api/files/file-1/shares'),
    fileId,
    encryptionKey,
    '2030-01-03T00:00:00.000Z',
  )

  assert.deepEqual(views.map((view) => view.id), ['active', 'revoked', 'expired'])
  assert.deepEqual(views.map((view) => view.active), [true, false, false])
  assert.ok(views.every((view) => view.url.startsWith('https://cloudhub.test/s/')))
})

test('revokeShare is idempotent and removes public access', async () => {
  const file = shareFile()
  const token = testToken()
  const tokenHash = await sha256Hex(token)
  const share = shareRecord({ id: 'share-1', token_hash: tokenHash, created_at: '2030-01-01T00:00:00.000Z' })
  const { repository } = shareRepository([file], [share])

  await revokeShare(
    authRepository(),
    repository,
    request('https://cloudhub.test/api/shares/share-1', 'DELETE'),
    'share-1',
    '2030-01-02T00:00:00.000Z',
  )
  assert.equal(share.revoked_at, '2030-01-02T00:00:00.000Z')

  await revokeShare(
    authRepository(),
    repository,
    request('https://cloudhub.test/api/shares/share-1', 'DELETE'),
    'share-1',
    '2030-01-03T00:00:00.000Z',
  )
  assert.equal(share.revoked_at, '2030-01-02T00:00:00.000Z')

  await assert.rejects(
    getPublicShareMetadata(repository, token, '2030-01-03T00:00:00.000Z'),
    (error: unknown) => error instanceof ShareServiceError && error.code === 'not_found',
  )
})

test('getPublicShareMetadata returns only file fields and hides inactive links', async () => {
  const token = testToken()
  const tokenHash = await sha256Hex(token)
  const active = shareRecord({ id: 'active', token_hash: tokenHash })
  const { repository } = shareRepository([shareFile()], [active])

  const metadata = await getPublicShareMetadata(repository, token, '2030-01-01T00:00:00.000Z')
  assert.deepEqual(metadata, {
    name: '报告.txt',
    sizeBytes: 100,
    mimeType: 'text/plain',
    expiresAt: null,
  })

  const { repository: expiredRepo } = shareRepository(
    [shareFile()],
    [shareRecord({ token_hash: tokenHash, expires_at: '2030-01-01T00:00:00.000Z' })],
  )
  await assert.rejects(
    getPublicShareMetadata(expiredRepo, token, '2030-01-02T00:00:00.000Z'),
    (error: unknown) => error instanceof ShareServiceError && error.code === 'not_found',
  )

  const { repository: trashedRepo } = shareRepository(
    [shareFile({ deleted_at: '2030-01-01T00:00:00.000Z' })],
    [shareRecord({ token_hash: tokenHash })],
  )
  await assert.rejects(
    getPublicShareMetadata(trashedRepo, token, '2030-01-01T00:00:00.000Z'),
    (error: unknown) => error instanceof ShareServiceError && error.code === 'not_found',
  )

  await assert.rejects(
    getPublicShareMetadata(repository, 'not-a-valid-token', '2030-01-01T00:00:00.000Z'),
    (error: unknown) => error instanceof ShareServiceError && error.code === 'not_found',
  )
})

test('streamPublicShare supports range requests and returns 416 for out-of-range starts', async () => {
  const token = testToken()
  const tokenHash = await sha256Hex(token)
  const { repository, incremented } = shareRepository(
    [shareFile()],
    [shareRecord({ id: 'share-1', token_hash: tokenHash })],
  )
  const store = new MockBlobStore()
  const bytes = new Uint8Array(100)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index
  await store.put({ objectKey: 'objects/file-1', body: bytes, contentType: 'application/octet-stream' })

  const full = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download'),
    token,
  )
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(full.headers.get('Content-Length'), '100')
  assert.deepEqual(Array.from(await readBody(full)), Array.from(bytes))

  const ranged = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download', 'GET', { Range: 'bytes=0-9' }),
    token,
  )
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('Content-Range'), 'bytes 0-9/100')
  assert.equal(ranged.headers.get('Content-Length'), '10')
  assert.deepEqual(Array.from(await readBody(ranged)), Array.from(bytes.slice(0, 10)))

  const suffix = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download', 'GET', { Range: 'bytes=-5' }),
    token,
  )
  assert.equal(suffix.status, 206)
  assert.equal(suffix.headers.get('Content-Range'), 'bytes 95-99/100')
  assert.deepEqual(Array.from(await readBody(suffix)), Array.from(bytes.slice(95)))

  const outOfRange = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download', 'GET', { Range: 'bytes=500-' }),
    token,
  )
  assert.equal(outOfRange.status, 416)
  assert.equal(outOfRange.headers.get('Content-Range'), 'bytes */100')

  assert.deepEqual(incremented, ['share-1', 'share-1'])
})

test('streamPublicShare counts downloads only from byte zero', async () => {
  const token = testToken()
  const tokenHash = await sha256Hex(token)
  const share = shareRecord({ id: 'share-1', token_hash: tokenHash })
  const { repository, incremented } = shareRepository([shareFile()], [share])
  const store = new MockBlobStore()
  await store.put({ objectKey: 'objects/file-1', body: new Uint8Array(100), contentType: 'text/plain' })

  await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download', 'GET', { Range: 'bytes=50-59' }),
    token,
  )
  assert.deepEqual(incremented, [])

  await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download', 'GET', { Range: 'bytes=0-9' }),
    token,
  )
  assert.deepEqual(incremented, ['share-1'])
})

test('inline downloads whitelist media types but keep other types as attachments', async () => {
  const imageFile = shareFile({ id: 'file-image', object_key: 'objects/image', mime_type: 'image/png' })
  const htmlFile = shareFile({ id: 'file-html', object_key: 'objects/html', mime_type: 'text/html' })
  const imageToken = testToken()
  const htmlToken = 'A'.repeat(43)
  const imageHash = await sha256Hex(imageToken)
  const htmlHash = await sha256Hex(htmlToken)
  const { repository } = shareRepository(
    [imageFile, htmlFile],
    [
      shareRecord({ id: 'share-image', file_id: 'file-image', token_hash: imageHash }),
      shareRecord({ id: 'share-html', file_id: 'file-html', token_hash: htmlHash }),
    ],
  )
  const store = new MockBlobStore()
  await store.put({ objectKey: 'objects/image', body: new Uint8Array(4), contentType: 'image/png' })
  await store.put({ objectKey: 'objects/html', body: new Uint8Array(4), contentType: 'text/html' })

  const image = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download?inline=1'),
    imageToken,
  )
  assert.match(image.headers.get('Content-Disposition') ?? '', /^inline; filename=/u)

  const html = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download?inline=1'),
    htmlToken,
  )
  assert.match(html.headers.get('Content-Disposition') ?? '', /^attachment; filename=/u)
})

test('owner handlers reject wrong methods and cross-origin writes', async () => {
  const { repository } = shareRepository([shareFile()])
  const fileShares = createFileSharesHandler({
    createAuthRepository: () => authRepository(),
    createShareRepository: () => repository,
  })

  const wrongMethod = await handlerContext(
    fileShares,
    request('https://cloudhub.test/api/files/file-1/shares', 'PUT'),
    { id: fileId },
  )
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('Allow'), 'GET, POST')

  const crossOrigin = await handlerContext(
    fileShares,
    new Request('https://cloudhub.test/api/files/file-1/shares', {
      method: 'POST',
      headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 7 }),
    }),
    { id: fileId },
  )
  assert.equal(crossOrigin.status, 403)
})

test('owner handlers map invalid expiry to 400 and foreign files to 404', async () => {
  const { repository } = shareRepository([shareFile()])
  const fileShares = createFileSharesHandler({
    createAuthRepository: () => authRepository(),
    createShareRepository: () => repository,
  })

  const invalid = await handlerContext(
    fileShares,
    new Request('https://cloudhub.test/api/files/file-1/shares', {
      method: 'POST',
      headers: {
        Origin: 'https://cloudhub.test',
        'Content-Type': 'application/json',
        Cookie: 'cloudhub_session=session',
      },
      body: JSON.stringify({ expiresInDays: 2 }),
    }),
    { id: fileId },
  )
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'invalid_request' })

  const foreignRepo = shareRepository([shareFile({ owner_id: otherOwner.id })])
  const foreignHandler = createFileSharesHandler({
    createAuthRepository: () => authRepository(),
    createShareRepository: () => foreignRepo.repository,
  })
  const foreign = await handlerContext(
    foreignHandler,
    new Request('https://cloudhub.test/api/files/file-1/shares', {
      method: 'POST',
      headers: {
        Origin: 'https://cloudhub.test',
        'Content-Type': 'application/json',
        Cookie: 'cloudhub_session=session',
      },
      body: JSON.stringify({ expiresInDays: 7 }),
    }),
    { id: fileId },
  )
  assert.equal(foreign.status, 404)
})

test('share list, delete, and public metadata handlers enforce auth and methods', async () => {
  const token = testToken()
  const tokenHash = await sha256Hex(token)
  const { repository } = shareRepository(
    [shareFile()],
    [shareRecord({ id: 'share-1', token_hash: tokenHash })],
  )

  const index = createSharesIndexHandler({
    createAuthRepository: () => authRepository(null),
    createShareRepository: () => repository,
  })
  assert.equal((await handlerContext(index, request('https://cloudhub.test/api/shares'))).status, 401)

  const deleteHandler = createShareDeleteHandler({
    createAuthRepository: () => authRepository(),
    createShareRepository: () => repository,
  })
  const crossOriginDelete = await handlerContext(
    deleteHandler,
    new Request('https://cloudhub.test/api/shares/share-1', {
      method: 'DELETE',
      headers: { Origin: 'https://attacker.test' },
    }),
    { id: 'share-1' },
  )
  assert.equal(crossOriginDelete.status, 403)

  const publicMetadata = createPublicShareMetadataHandler({
    createShareRepository: () => repository,
  })
  const metadata = await handlerContext(
    publicMetadata,
    request(`https://cloudhub.test/api/public/shares/${token}`),
    { token },
  )
  assert.equal(metadata.status, 200)
  assert.equal(metadata.headers.get('Cache-Control'), 'no-store')
  assert.equal(metadata.headers.get('X-Robots-Tag'), 'noindex')

  const publicDownload = createPublicShareDownloadHandler({
    createShareRepository: () => repository,
    createBlobStore: () => new MockBlobStore(),
  })
  const notFound = await handlerContext(
    publicDownload,
    request('https://cloudhub.test/api/public/shares/bad-token/download'),
    { token: 'bad-token' },
  )
  assert.equal(notFound.status, 404)
})
