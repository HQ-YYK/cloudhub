import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentRange, parseByteRange, unsatisfiedContentRange } from './range.ts'

test('parseByteRange resolves inclusive and open-ended ranges', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 200), { kind: 'range', start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=0-99', 50), { kind: 'range', start: 0, end: 49 })
  assert.deepEqual(parseByteRange('bytes=50-', 100), { kind: 'range', start: 50, end: 99 })
  assert.deepEqual(parseByteRange('bytes=0-0', 100), { kind: 'range', start: 0, end: 0 })
})

test('parseByteRange resolves suffix ranges and clamps to the full file', () => {
  assert.deepEqual(parseByteRange('bytes=-10', 100), { kind: 'range', start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-1', 5), { kind: 'range', start: 4, end: 4 })
  assert.deepEqual(parseByteRange('bytes=-200', 100), { kind: 'range', start: 0, end: 99 })
})

test('parseByteRange reports unsatisfiable ranges that start past the end', () => {
  assert.deepEqual(parseByteRange('bytes=500-', 100), { kind: 'not-satisfiable' })
  assert.deepEqual(parseByteRange('bytes=100-200', 100), { kind: 'not-satisfiable' })
  assert.deepEqual(parseByteRange('bytes=-1', 0), { kind: 'not-satisfiable' })
})

test('parseByteRange ignores malformed, multi-range, and wrong-unit headers', () => {
  const ignored = [
    null,
    'bytes=',
    'bytes=-',
    'bytes=0-1,5-6',
    'bytes=5-3',
    'bytes=-0',
    'bytes=abc',
    'chunks=0-1',
    'bytes=0-1 ',
    'bytes= 0-1',
    'bytes=999999999999999999999-',
  ]
  for (const header of ignored) {
    assert.deepEqual(parseByteRange(header, 100), { kind: 'ignore' }, String(header))
  }
})

test('contentRange helpers build the range response headers', () => {
  assert.equal(contentRange(0, 99, 200), 'bytes 0-99/200')
  assert.equal(unsatisfiedContentRange(200), 'bytes */200')
})

test('inline content types exclude svg and ignore case and parameters', async () => {
  const { allowsInlineContentType } = await import('./http.ts')
  assert.equal(allowsInlineContentType('image/svg+xml'), false)
  assert.equal(allowsInlineContentType('IMAGE/SVG+XML'), false)
  assert.equal(allowsInlineContentType('text/html'), false)
  assert.equal(allowsInlineContentType('Image/PNG'), true)
  assert.equal(allowsInlineContentType('text/plain; charset=utf-8'), true)
})
