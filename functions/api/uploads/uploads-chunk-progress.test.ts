import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUploadChunkHandler } from './[id]/chunk.ts'
import { createUploadStatusHandler } from './[id]/index.ts'
import {
  buildOverrides,
  chunkRequest,
  encryptedSessionUri,
  env,
  file,
  fileId,
  makeDriveClient,
  otherOwner,
  session,
  sessionCookie,
} from './uploads.fixtures.ts'

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
