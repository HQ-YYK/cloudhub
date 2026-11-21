import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deleteFile, downloadFile } from './files.ts'

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
