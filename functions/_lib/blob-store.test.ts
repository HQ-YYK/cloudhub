import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BlobStoreError,
  type BlobObject,
} from './blob-store.ts'
import {
  MAX_BLOB_METADATA_ENTRIES,
  MAX_BLOB_METADATA_KEY_LENGTH,
  MAX_BLOB_METADATA_VALUE_LENGTH,
  MockBlobStore,
} from './mock-blob-store.ts'

async function readBytes(object: BlobObject) {
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

function assertBlobError(error: unknown, code: BlobStoreError['code']) {
  assert.ok(error instanceof BlobStoreError)
  assert.equal(error.code, code)
}

test('put stores bytes and get returns an independent readable object', async () => {
  const store = new MockBlobStore()
  const source = new TextEncoder().encode('hello blob')
  const created = await store.put({
    objectKey: 'objects/file-1/content',
    body: source,
    contentType: 'text/plain',
    metadata: { purpose: 'test' },
  })

  source[0] = 0
  const object = await store.get('objects/file-1/content')
  assert.deepEqual(Array.from(await readBytes(object)), Array.from(new TextEncoder().encode('hello blob')))
  assert.equal(object.sizeBytes, 10)
  assert.equal(object.contentType, 'text/plain')
  assert.deepEqual(object.metadata, { purpose: 'test' })
  assert.equal(object.etag, created.etag)
})

test('head returns object metadata without a body', async () => {
  const store = new MockBlobStore()
  await store.put({ objectKey: 'objects/file-2/content', body: new Uint8Array([1, 2, 3]) })

  const head = await store.head('objects/file-2/content')
  assert.deepEqual(head, {
    objectKey: 'objects/file-2/content',
    sizeBytes: 3,
    metadata: {},
    contentType: null,
    etag: '"mock-1"',
  })
})

test('delete removes the object and subsequent access reports not found', async () => {
  const store = new MockBlobStore()
  await store.put({ objectKey: 'objects/file-3/content', body: new Uint8Array([1]) })
  await store.delete('objects/file-3/content')

  await assert.rejects(store.get('objects/file-3/content'), (error) => {
    assertBlobError(error, 'not_found')
    return true
  })
  await assert.rejects(store.delete('objects/file-3/content'), (error) => {
    assertBlobError(error, 'not_found')
    return true
  })
})

test('duplicate writes require explicit overwrite and update the etag', async () => {
  const store = new MockBlobStore()
  const first = await store.put({ objectKey: 'objects/file-4/content', body: new Uint8Array([1]) })

  await assert.rejects(
    store.put({ objectKey: 'objects/file-4/content', body: new Uint8Array([2]) }),
    (error) => {
      assertBlobError(error, 'conflict')
      return true
    },
  )

  const replacement = await store.put({
    objectKey: 'objects/file-4/content',
    body: new Uint8Array([2]),
    overwrite: true,
  })
  assert.notEqual(replacement.etag, first.etag)
  assert.deepEqual(Array.from(await readBytes(await store.get('objects/file-4/content'))), [2])
})

test('stream bodies are supported and enforce the configured size limit', async () => {
  const store = new MockBlobStore({ maxObjectSizeBytes: 3 })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3]))
      controller.close()
    },
  })
  const created = await store.put({ objectKey: 'objects/file-5/content', body })
  assert.equal(created.sizeBytes, 3)

  const tooLarge = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]))
      controller.close()
    },
  })
  await assert.rejects(
    store.put({ objectKey: 'objects/file-6/content', body: tooLarge }),
    (error) => {
      assertBlobError(error, 'too_large')
      return true
    },
  )
})

test('metadata, object keys, and size limits reject invalid boundaries', async () => {
  const store = new MockBlobStore({ maxObjectSizeBytes: 0 })
  await assert.rejects(
    store.put({ objectKey: 'objects/file-7/content', body: new Uint8Array([1]) }),
    (error) => {
      assertBlobError(error, 'too_large')
      return true
    },
  )
  await assert.rejects(
    store.put({ objectKey: '', body: new Uint8Array() }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
  await assert.rejects(
    store.put({
      objectKey: 'objects/file-8/content',
      body: new Uint8Array(),
      metadata: { ['k'.repeat(MAX_BLOB_METADATA_KEY_LENGTH + 1)]: 'value' },
    }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
  await assert.rejects(
    store.put({
      objectKey: 'objects/file-9/content',
      body: new Uint8Array(),
      metadata: { key: 'v'.repeat(MAX_BLOB_METADATA_VALUE_LENGTH + 1) },
    }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
  await assert.rejects(
    store.put({
      objectKey: 'objects/file-10/content',
      body: new Uint8Array(),
      metadata: Object.fromEntries(
        Array.from({ length: MAX_BLOB_METADATA_ENTRIES + 1 }, (_, index) => [`key-${index}`, 'value']),
      ),
    }),
    (error) => {
      assertBlobError(error, 'invalid_request')
      return true
    },
  )
})
