import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockBlobStore } from '../../_lib/mock-blob-store.ts'
import { decryptSecret, encryptSecret } from '../../_lib/secret-box.ts'
import type { ShareRecord } from '../../_lib/share-repository.ts'
import {
  createShare,
  getPublicShareMetadata,
  listSharesByFile,
  revokeShare,
  ShareServiceError,
  streamPublicShare,
} from '../../_lib/share-service.ts'
import {
  authRepository,
  encryptionKey,
  fileId,
  makeToken,
  otherOwner,
  readBody,
  request,
  shareFile,
  shareRecord,
  shareRepository,
  sha256Hex,
  testToken,
} from './shares.fixtures.ts'

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
  assert.ok(views.every((view) => view.enc === 0))
  assert.ok(views.every((view) => view.encName === '报告.txt'))
  assert.ok(views.every((view) => view.wrappedKey === null))
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
    id: fileId,
    enc: 0,
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

test('getPublicShareMetadata returns encName for encrypted files', async () => {
  const token = testToken()
  const tokenHash = await sha256Hex(token)
  const encName = 'A'.repeat(44)
  const wrappedKey = 'A'.repeat(80)
  const { repository } = shareRepository(
    [shareFile({ enc: 1, wrapped_key: wrappedKey, name: encName, mime_type: 'application/octet-stream' })],
    [shareRecord({ id: 'active', token_hash: tokenHash })],
  )

  const metadata = await getPublicShareMetadata(repository, token, '2030-01-01T00:00:00.000Z')
  assert.deepEqual(metadata, {
    id: fileId,
    enc: 1,
    encName,
    sizeBytes: 100,
    mimeType: 'application/octet-stream',
    expiresAt: null,
  })
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
  assert.match(image.headers.get('Content-Security-Policy') ?? '', /sandbox/u)

  const html = await streamPublicShare(
    repository,
    () => store,
    request('https://cloudhub.test/api/public/shares/token/download?inline=1'),
    htmlToken,
  )
  assert.match(html.headers.get('Content-Disposition') ?? '', /^attachment; filename=/u)
})
