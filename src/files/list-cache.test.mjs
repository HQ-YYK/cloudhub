import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ListCache,
  PREFETCH_LIMIT,
  prefetchChildDirectories,
  resolveDisplayItems,
} from './list-cache.ts'

function driveItem(id, kind = 'directory', name = 'x') {
  return {
    id,
    parent_id: null,
    kind,
    name,
    size_bytes: null,
    mime_type: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    enc: 0,
    wrappedKey: null,
  }
}

function displayItem(id, kind = 'directory', name = 'x') {
  return { item: driveItem(id, kind, name), name, status: 'plain' }
}

test('resolveDisplayItems marks encrypted items as failed without a master key', async () => {
  const result = await resolveDisplayItems(null, [
    driveItem('f1', 'file', 'plain.txt'),
    { ...driveItem('f2', 'file'), enc: 1 },
  ])

  assert.equal(result[0].name, 'plain.txt')
  assert.equal(result[0].status, 'plain')
  assert.equal(result[1].status, 'failed')
})

test('list cache stores, hits, and invalidates by parent id', () => {
  const cache = new ListCache()
  cache.set(null, [displayItem('d1')])
  cache.set('parent', [displayItem('d2')])

  assert.equal(cache.has(null), true)
  assert.deepEqual(cache.get(null).map((entry) => entry.item.id), ['d1'])

  cache.invalidate(null)
  assert.equal(cache.has(null), false)
  assert.equal(cache.has('parent'), true)
})

test('invalidateMove clears both source and target directories', () => {
  const cache = new ListCache()
  cache.set('source', [displayItem('a')])
  cache.set('target', [displayItem('b')])

  cache.invalidateMove('source', 'target')

  assert.equal(cache.has('source'), false)
  assert.equal(cache.has('target'), false)
})

test('invalidateMove handles moving within the same directory', () => {
  const cache = new ListCache()
  cache.set('same', [displayItem('a')])

  cache.invalidateMove('same', 'same')

  assert.equal(cache.has('same'), false)
})

test('clear empties the cache', () => {
  const cache = new ListCache()
  cache.set(null, [displayItem('a')])
  cache.set('x', [displayItem('b')])

  cache.clear()

  assert.equal(cache.has(null), false)
  assert.equal(cache.has('x'), false)
})

test('latest request guard rejects stale responses', () => {
  const cache = new ListCache()
  const first = cache.beginRequest()
  const second = cache.beginRequest()

  assert.equal(cache.isLatestRequest(first), false)
  assert.equal(cache.isLatestRequest(second), true)
})

test('prefetch caps at the limit, skips cached entries, and runs serially', async () => {
  const cache = new ListCache()
  const loaded = []
  const entries = [
    displayItem('d1'),
    displayItem('d2'),
    displayItem('d3'),
    displayItem('d4'),
    displayItem('d5'),
    displayItem('d6'),
  ]
  cache.set('d3', [])

  await prefetchChildDirectories(cache, entries, async (id) => {
    loaded.push(id)
  })

  assert.deepEqual(loaded, ['d1', 'd2', 'd4', 'd5', 'd6'])
  assert.equal(loaded.length, PREFETCH_LIMIT)
})

test('prefetch ignores failed loads', async () => {
  const cache = new ListCache()

  await prefetchChildDirectories(cache, [displayItem('d1')], async () => {
    throw new Error('boom')
  })

  assert.equal(cache.has('d1'), false)
})

test('commit drops a response that started before clear', () => {
  const cache = new ListCache()
  const before = cache.currentGeneration()
  cache.clear()

  assert.equal(cache.commit('d1', [displayItem('x')], before), false)
  assert.equal(cache.has('d1'), false)
  assert.equal(cache.commit('d1', [displayItem('x')], cache.currentGeneration()), true)
  assert.equal(cache.has('d1'), true)
})
