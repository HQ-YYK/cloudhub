import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deleteFile, downloadFile, moveItem, renameItem } from './files.ts'

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

test('rename uses PATCH and the encoded file ID', async () => {
  let request
  const restore = mockFetch(
    new Response(JSON.stringify({ item: { id: 'file/id', name: 'new.txt' } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
    (input, init) => {
      request = { input, init }
    },
  )
  try {
    await renameItem('file/id', 'new.txt')
    assert.equal(request.input, '/api/files/file%2Fid')
    assert.equal(request.init.method, 'PATCH')
    assert.equal(request.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.init.body), { name: 'new.txt' })
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
