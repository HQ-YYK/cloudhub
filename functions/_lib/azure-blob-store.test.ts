import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BlobStoreError,
  type BlobObject,
} from './blob-store.ts'
import {
  createAzureClientCredentialsAuth,
} from './azure-blob-auth.ts'
import {
  AzureBlobStore,
} from './azure-blob-store.ts'

interface FetchCall {
  input: RequestInfo | URL
  init?: RequestInit
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body: BodyInit | null = null,
) {
  return new Response(body, { status, headers })
}

function queuedFetch(results: Array<Response | Error>) {
  const calls: FetchCall[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    const result = results.shift()
    if (!result) throw new Error('unexpected_fetch')
    if (result instanceof Error) throw result
    return result
  }
  return { fetchImpl, calls }
}

function tokenProvider(token = 'access-token') {
  return {
    getAccessToken: async () => token,
  }
}

function store(
  fetchImpl: typeof fetch,
  options: { token?: string; endpoint?: string } = {},
) {
  return new AzureBlobStore({
    accountName: 'cloudhub',
    containerName: 'private-files',
    endpoint: options.endpoint ?? 'https://blob.test',
    tokenProvider: tokenProvider(options.token),
    fetchImpl,
  })
}

function assertBlobError(error: unknown, code: BlobStoreError['code']) {
  assert.ok(error instanceof BlobStoreError)
  assert.equal(error.code, code)
}

async function readObject(object: BlobObject) {
  const reader = object.body.getReader()
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

test('gets and caches an Entra client-credentials token, then refreshes it early', async () => {
  let currentTime = 0
  const queued = queuedFetch([
    response(200, {}, JSON.stringify({ access_token: 'token-1', expires_in: 120 })),
    response(200, {}, JSON.stringify({ access_token: 'token-2', expires_in: 120 })),
  ])
  const auth = createAzureClientCredentialsAuth({
    tenantId: 'tenant',
    clientId: 'client',
    clientSecret: 'secret-value',
    fetchImpl: queued.fetchImpl,
    now: () => currentTime,
  })

  assert.equal(await auth.getAccessToken(), 'token-1')
  assert.equal(await auth.getAccessToken(), 'token-1')
  currentTime = 61_000
  assert.equal(await auth.getAccessToken(), 'token-2')
  assert.equal(queued.calls.length, 2)

  const firstBody = queued.calls[0]?.init?.body
  assert.ok(firstBody instanceof URLSearchParams)
  assert.equal(firstBody.get('grant_type'), 'client_credentials')
  assert.equal(firstBody.get('scope'), 'https://storage.azure.com/.default')
  assert.equal(firstBody.get('client_id'), 'client')
  assert.equal(firstBody.get('client_secret'), 'secret-value')
  assert.match(String(queued.calls[0]?.input), /login\.microsoftonline\.com\/tenant\/oauth2\/v2\.0\/token/u)
})

test('does not expose credentials when Entra authentication fails', async () => {
  const secret = 'secret-value'
  const queued = queuedFetch([response(401)])
  const auth = createAzureClientCredentialsAuth({
    tenantId: 'tenant',
    clientId: 'client',
    clientSecret: secret,
    fetchImpl: queued.fetchImpl,
  })

  await assert.rejects(auth.getAccessToken(), (error) => {
    assertBlobError(error, 'unavailable')
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'))
    return true
  })
})

test('puts bytes with Azure headers, metadata, conditional overwrite, and encoded key', async () => {
  const queued = queuedFetch([
    response(201, { ETag: '"etag-1"' }),
    response(201, { ETag: '"etag-2"' }),
  ])
  const blobStore = store(queued.fetchImpl, { token: 'token-value' })
  const body = new Uint8Array([1, 2, 3])

  const created = await blobStore.put({
    objectKey: 'objects/file id/content',
    body,
    contentType: 'text/plain',
    metadata: { purpose: 'test' },
  })
  const overwritten = await blobStore.put({
    objectKey: 'objects/file id/content',
    body: new ArrayBuffer(0),
    overwrite: true,
  })

  assert.deepEqual(created, {
    objectKey: 'objects/file id/content',
    sizeBytes: 3,
    metadata: { purpose: 'test' },
    contentType: 'text/plain',
    etag: '"etag-1"',
  })
  assert.equal(overwritten.sizeBytes, 0)
  const firstCall = queued.calls[0]
  assert.equal(firstCall?.init?.method, 'PUT')
  assert.equal(String(firstCall?.input), 'https://blob.test/private-files/objects/file%20id/content')
  assert.equal(firstCall?.init?.headers instanceof Headers, true)
  const firstHeaders = firstCall?.init?.headers as Headers
  assert.equal(firstHeaders.get('Authorization'), 'Bearer token-value')
  assert.equal(firstHeaders.get('x-ms-version'), '2023-11-03')
  assert.equal(firstHeaders.get('x-ms-blob-type'), 'BlockBlob')
  assert.equal(firstHeaders.get('Content-Length'), '3')
  assert.equal(firstHeaders.get('Content-Type'), 'text/plain')
  assert.equal(firstHeaders.get('If-None-Match'), '*')
  assert.equal(firstHeaders.get('x-ms-meta-purpose'), 'test')
  assert.equal(firstCall?.init?.redirect, 'error')
  assert.deepEqual(Array.from(firstCall?.init?.body as Uint8Array), [1, 2, 3])

  const secondHeaders = queued.calls[1]?.init?.headers as Headers
  assert.equal(secondHeaders.get('If-None-Match'), null)
  assert.equal(secondHeaders.get('Content-Length'), '0')
})

test('gets a streamed blob and parses metadata', async () => {
  const queued = queuedFetch([
    response(
      200,
      {
        'Content-Length': '5',
        'Content-Type': 'text/plain',
        ETag: '"etag-2"',
        'x-ms-meta-purpose': 'test',
      },
      'hello',
    ),
  ])
  const object = await store(queued.fetchImpl).get('objects/file/content')

  assert.equal(object.sizeBytes, 5)
  assert.equal(object.contentType, 'text/plain')
  assert.equal(object.etag, '"etag-2"')
  assert.deepEqual(Array.from(await readObject(object)), Array.from(new TextEncoder().encode('hello')))
  assert.equal(queued.calls[0]?.init?.method, 'GET')
})

test('heads a blob without reading its body', async () => {
  const queued = queuedFetch([
    response(200, {
      'Content-Length': '0',
      ETag: '"etag-empty"',
      'x-ms-meta-purpose': 'empty',
    }),
  ])
  const head = await store(queued.fetchImpl).head('objects/file/content')

  assert.deepEqual(head, {
    objectKey: 'objects/file/content',
    sizeBytes: 0,
    metadata: { purpose: 'empty' },
    contentType: null,
    etag: '"etag-empty"',
  })
  assert.equal(queued.calls[0]?.init?.method, 'HEAD')
})

test('deletes a blob and maps a missing blob to not_found', async () => {
  const successful = queuedFetch([response(202)])
  await store(successful.fetchImpl).delete('objects/file/content')
  assert.equal(successful.calls[0]?.init?.method, 'DELETE')

  const missing = queuedFetch([response(404)])
  await assert.rejects(
    store(missing.fetchImpl).delete('objects/file/content'),
    (error) => {
      assertBlobError(error, 'not_found')
      return true
    },
  )
})

test('maps Azure error responses without collapsing them into not_found', async () => {
  for (const [status, code] of [
    [400, 'invalid_request'],
    [409, 'conflict'],
    [401, 'unavailable'],
    [403, 'unavailable'],
    [413, 'too_large'],
    [500, 'unavailable'],
  ] as const) {
    const queued = queuedFetch([response(status)])
    await assert.rejects(
      store(queued.fetchImpl).put({
        objectKey: 'objects/file/content',
        body: new Uint8Array(),
      }),
      (error) => {
        assertBlobError(error, code)
        return true
      },
      `status ${status}`,
    )
  }
})

test('maps network failures to unavailable and rejects malformed response fields', async () => {
  const network = queuedFetch([new Error('network failure')])
  await assert.rejects(
    store(network.fetchImpl).get('objects/file/content'),
    (error) => {
      assertBlobError(error, 'unavailable')
      assert.doesNotMatch(String(error), /network failure/u)
      return true
    },
  )

  const invalidLength = queuedFetch([
    response(200, { 'Content-Length': 'not-a-size', ETag: '"etag"' }, ''),
  ])
  await assert.rejects(
    store(invalidLength.fetchImpl).get('objects/file/content'),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )

  const missingEtag = queuedFetch([
    response(201),
  ])
  await assert.rejects(
    store(missingEtag.fetchImpl).put({
      objectKey: 'objects/file/content',
      body: new Uint8Array(),
    }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
})

test('supports ArrayBuffer and empty bodies but rejects unknown streams before fetch', async () => {
  const queued = queuedFetch([
    response(201, { ETag: '"etag-array"' }),
    response(201, { ETag: '"etag-empty"' }),
  ])
  const blobStore = store(queued.fetchImpl)

  await blobStore.put({
    objectKey: 'objects/array/content',
    body: new Uint8Array([4, 5]).buffer,
  })
  await blobStore.put({
    objectKey: 'objects/empty/content',
    body: new Uint8Array(),
  })
  assert.equal(queued.calls[0]?.init?.headers instanceof Headers, true)
  assert.equal((queued.calls[0]?.init?.headers as Headers).get('Content-Length'), '2')
  assert.equal((queued.calls[1]?.init?.headers as Headers).get('Content-Length'), '0')

  const streamFetch = queuedFetch([])
  await assert.rejects(
    store(streamFetch.fetchImpl).put({
      objectKey: 'objects/stream/content',
      body: new ReadableStream<Uint8Array>(),
    }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
  assert.equal(streamFetch.calls.length, 0)
})

test('rejects invalid object keys, metadata, and redirect-capable endpoints', async () => {
  const queued = queuedFetch([])
  const blobStore = store(queued.fetchImpl, { endpoint: 'http://blob.test' })
  await assert.rejects(
    blobStore.put({ objectKey: '../escape', body: new Uint8Array() }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
  await assert.rejects(
    blobStore.put({
      objectKey: 'objects/file/content',
      body: new Uint8Array(),
      metadata: { 'not-valid': 'value' },
    }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
  assert.equal(queued.calls.length, 0)
})
