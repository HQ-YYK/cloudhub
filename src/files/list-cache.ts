import { useCallback, useEffect, useState } from 'react'
import { FilesRequestError, listFiles, type DriveItem } from '../api/files.ts'
import { platformErrorMessage } from '../utils/service-limits.ts'
import { DECRYPT_FAILED_NAME, resolveDriveItems, type DisplayItem } from './session.ts'

export type ParentId = string | null

function listErrorMessage(error: unknown): string {
  const platform = platformErrorMessage(error)
  if (platform) return platform
  if (error instanceof FilesRequestError) {
    if (error.code === 'password_change_required') return '请先修改密码'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 404) return '目录或文件不存在或已不可访问。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return '目录加载失败，请稍后重试。'
}

export function resolveDisplayItems(mk: Uint8Array<ArrayBuffer> | null, items: DriveItem[]): Promise<DisplayItem[]> {
  if (mk) return resolveDriveItems(mk, items)
  return Promise.resolve(items.map((item) => ({
    item,
    name: item.enc === 1 ? DECRYPT_FAILED_NAME : item.name,
    status: item.enc === 1 ? 'failed' : 'plain',
  })))
}

export class ListCache {
  private store = new Map<ParentId, DisplayItem[]>()
  private latest = 0
  private generation = 0

  get(parentId: ParentId): DisplayItem[] | undefined {
    return this.store.get(parentId)
  }

  has(parentId: ParentId): boolean {
    return this.store.has(parentId)
  }

  set(parentId: ParentId, entries: DisplayItem[]): void {
    this.store.set(parentId, entries)
  }

  invalidate(parentId: ParentId): void {
    this.store.delete(parentId)
  }

  invalidateMove(source: ParentId, target: ParentId): void {
    this.store.delete(source)
    if (target !== source) this.store.delete(target)
  }

  clear(): void {
    this.store.clear()
    this.generation += 1
  }

  currentGeneration(): number {
    return this.generation
  }

  // Store only if no clear() happened since the request started, so a late
  // response cannot put decrypted names back after logout or lock.
  commit(parentId: ParentId, entries: DisplayItem[], generation: number): boolean {
    if (generation !== this.generation) return false
    this.store.set(parentId, entries)
    return true
  }

  beginRequest(): number {
    this.latest += 1
    return this.latest
  }

  isLatestRequest(token: number): boolean {
    return token === this.latest
  }

  async loadFresh(parentId: ParentId, mk: Uint8Array<ArrayBuffer> | null): Promise<DisplayItem[]> {
    const generation = this.generation
    const entries = await resolveDisplayItems(mk, await listFiles(parentId))
    this.commit(parentId, entries, generation)
    return entries
  }
}

export const listCache = new ListCache()

export const PREFETCH_LIMIT = 5

export async function prefetchChildDirectories(
  cache: ListCache,
  entries: DisplayItem[],
  loadChild: (childId: string) => Promise<unknown>,
  limit = PREFETCH_LIMIT,
): Promise<void> {
  const targets = entries
    .filter((entry) => entry.item.kind === 'directory' && !cache.has(entry.item.id))
    .slice(0, limit)
  for (const target of targets) {
    try {
      await loadChild(target.item.id)
    } catch {
      // Prefetch failures are best-effort and intentionally ignored.
    }
  }
}

export function useDirectoryList(masterKey: Uint8Array<ArrayBuffer> | null, parentId: ParentId) {
  const [entries, setEntries] = useState<DisplayItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    return () => listCache.clear()
  }, [])

  useEffect(() => {
    let cancelled = false
    const token = listCache.beginRequest()

    async function load() {
      const cached = listCache.get(parentId)
      if (cached) {
        if (cancelled) return
        setEntries(cached)
        setLoading(false)
        setLoadError('')
        try {
          const fresh = await listCache.loadFresh(parentId, masterKey)
          if (!cancelled && listCache.isLatestRequest(token)) setEntries(fresh)
        } catch {
          // Keep the cached entries when a background refresh fails.
        }
        return
      }
      if (cancelled) return
      setLoading(true)
      setLoadError('')
      try {
        const fresh = await listCache.loadFresh(parentId, masterKey)
        if (!cancelled && listCache.isLatestRequest(token)) {
          setEntries(fresh)
          setLoading(false)
        }
      } catch (error) {
        if (!cancelled && listCache.isLatestRequest(token)) {
          setEntries([])
          setLoadError(listErrorMessage(error))
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [parentId, masterKey])

  const refresh = useCallback(async () => {
    const token = listCache.beginRequest()
    setRefreshing(true)
    setLoadError('')
    try {
      const fresh = await listCache.loadFresh(parentId, masterKey)
      if (listCache.isLatestRequest(token)) setEntries(fresh)
    } catch (error) {
      if (listCache.isLatestRequest(token)) setLoadError(listErrorMessage(error))
    } finally {
      setRefreshing(false)
    }
  }, [parentId, masterKey])

  const invalidate = useCallback((target: ParentId) => {
    listCache.invalidate(target)
  }, [])

  useEffect(() => {
    if (!masterKey) return
    let cancelled = false
    void prefetchChildDirectories(listCache, entries, async (childId) => {
      if (!cancelled) await listCache.loadFresh(childId, masterKey)
    })
    return () => {
      cancelled = true
    }
  }, [entries, masterKey])

  return { entries, loading, refreshing, loadError, refresh, invalidate }
}
