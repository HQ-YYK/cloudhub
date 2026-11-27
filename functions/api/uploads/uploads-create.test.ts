import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlobStoreError } from '../../_lib/blob-store.ts'
import { decryptSecret } from '../../_lib/secret-box.ts'
import { createUploadHandler } from './index.ts'
import {
  buildOverrides,
  cipherSize,
  createBody,
  encName,
  env,
  file,
  fileId,
  key,
  makeDriveClient,
  nameKey,
  otherOwner,
  postBody,
  wrappedKey,
} from './uploads.fixtures.ts'

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
