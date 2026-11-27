import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockBlobStore } from '../../_lib/mock-blob-store.ts'
import { createFileSharesHandler } from '../files/[id]/shares.ts'
import { createPublicShareDownloadHandler } from '../public/shares/[token]/download.ts'
import { createPublicShareMetadataHandler } from '../public/shares/[token]/index.ts'
import { createShareDeleteHandler } from './[id].ts'
import { createSharesIndexHandler } from './index.ts'
import {
  authRepository,
  fileId,
  handlerContext,
  otherOwner,
  request,
  shareFile,
  shareRecord,
  shareRepository,
  sha256Hex,
  testToken,
} from './shares.fixtures.ts'

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
