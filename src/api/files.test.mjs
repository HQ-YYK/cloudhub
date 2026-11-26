import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDirectory, deleteFile, downloadFile, fetchFileRange, FilesRequestError, moveItem, renameItem } from './files.ts'

function mockFetch(response, capture) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    capture(input, init)
    return response
  }
  return () => {
    globalThis.fetch = original
  }
}

test('download uses the file ID and backend filename', async () => {
  let request
  const originalDocument = globalThis.document
  let anchor
  globalThis.document = {
    body: { append() {} },
    createElement() {
      anchor = {
        click() {},
        remove() {},
      }
      return anchor
    },
  }
  const restore = mockFetch(
    new Response('hello', {
      headers: {
        'Content-Disposition': "attachment; filename=\"hello.txt\"; filename*=UTF-8''hello.txt",
        'Content-Type': 'text/plain',
      },
    }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    await downloadFile('file/id')
    assert.equal(request.input, '/api/files/file%2Fid/download')
    assert.equal(request.init.credentials, 'same-origin')
    assert.match(anchor.download, /hello\.txt/u)
  } finally {
    restore()
    globalThis.document = originalDocument
  }
})

test('delete uses DELETE and the encoded file ID', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ deleted: true }), {
      headers: { 'Content-Type': 'application/json' },
    }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    await deleteFile('file/id')
    assert.equal(request.input, '/api/files/file%2Fid')
    assert.equal(request.init.method, 'DELETE')
    assert.equal(request.init.credentials, 'same-origin')
  } finally {
    restore()
  }
})

test('rename sends the encrypted name fields', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ item: { id: 'file/id', enc: 1, name: 'enc' } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    await renameItem('file/id', { encName: 'enc', nameKey: 'nk' })
    assert.equal(request.input, '/api/files/file%2Fid')
    assert.equal(request.init.method, 'PATCH')
    assert.equal(request.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.init.body), { encName: 'enc', nameKey: 'nk' })
  } finally {
    restore()
  }
})

test('move uses PATCH and sends the target parentId', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ item: { id: 'file/id' } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    await moveItem('file/id', 'parent/id')
    assert.equal(request.input, '/api/files/file%2Fid')
    assert.equal(request.init.method, 'PATCH')
    assert.deepEqual(JSON.parse(request.init.body), { parentId: 'parent/id' })
  } finally {
    restore()
  }
})

test('createDirectory posts the encrypted directory fields', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ item: { id: 'd1' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    await createDirectory({ id: 'd1', parentId: 'parent/id', encName: 'enc', nameKey: 'nk' })
    assert.equal(request.input, '/api/files/directories')
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(JSON.parse(request.init.body), { id: 'd1', parent_id: 'parent/id', encName: 'enc', nameKey: 'nk' })
  } finally {
    restore()
  }
})

test('requestFiles maps a 429 non-JSON response to platform_limited', async () => {
  const restore = mockFetch(
    new Response('<html>rate limited</html>', {
      status: 429,
      headers: { 'Content-Type': 'text/html' },
    }),
    () => {},
  )
  try {
    await assert.rejects(
      () => createDirectory({ id: 'd1', parentId: null, encName: 'enc', nameKey: 'nk' }),
      (error) => error instanceof FilesRequestError && error.status === 429 && error.code === 'platform_limited',
    )
  } finally {
    restore()
  }
})

test('fetchFileRange requests a byte range and returns a stream', async () => {
  let request
  const restore = mockFetch(
    new Response('abcdef', { headers: { 'Content-Type': 'application/octet-stream' } }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    const stream = await fetchFileRange('file/id', 100, 106)
    assert.equal(request.input, '/api/files/file%2Fid/download')
    assert.equal(request.init.headers.Range, 'bytes=100-105')
    const reader = stream.getReader()
    const { value } = await reader.read()
    assert.deepEqual([...value], [...new TextEncoder().encode('abcdef')])
  } finally {
    restore()
  }
})
