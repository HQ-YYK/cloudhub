import { useCallback, useEffect, useState } from 'react'
import { emptyTrash, listTrash, purgeTrashItem, restoreTrashItem, type TrashItem } from '../api/trash'
import { FilesRequestError } from '../api/files'
import { useAuth } from '../auth/useAuth'
import { resolveDisplayName } from '../files/session'
import { FolderIcon } from './DriveIcons'

function TrashEmptyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      <path d="M4.5 7.25h15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.25 7V5.25A1.25 1.25 0 0 1 10.5 4h3a1.25 1.25 0 0 1 1.25 1.25V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.5 7.25 7.3 19a1.75 1.75 0 0 0 1.74 1.5h5.92A1.75 1.75 0 0 0 16.7 19l.8-11.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11.25v4.5M14 11.25v4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      <path d="M6.25 2.75h7.5l4 4v14.5H6.25a1.5 1.5 0 0 1-1.5-1.5V4.25a1.5 1.5 0 0 1 1.5-1.5Z" fill="#f0edff" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M13.75 2.75v4.25h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8 11.25h8M8 14.75h8M8 18.25h5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof FilesRequestError) {
    if (error.status === 409) return '原位置已有同名文件，请先处理同名文件后再恢复。'
    if (error.status === 410) return '文件已被永久删除。'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 503) return '存储暂时不可用，请稍后重试。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return '操作失败，请稍后重试。'
}

function purgeError(error: string | undefined, remaining: number): string {
  if (error === 'storage_reauth_required') {
    return 'Google 账号授权已失效，请管理员到「存储」页重新授权后再删除。'
  }
  if (error === 'storage_not_connected') {
    return '部分文件所在的 Google 账号已移除，无法删除。'
  }
  return `还有 ${remaining} 项没有删掉，请稍后重试。`
}

function formatFileSize(size: number | null) {
  if (size === null) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatDeletedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '删除时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function daysUntilExpiry(expiresAt: string): string {
  const expiry = new Date(expiresAt)
  if (Number.isNaN(expiry.getTime())) return '剩余时间未知'
  const days = (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  if (days < 1) return '今天到期'
  return `${Math.ceil(days)} 天后永久删除`
}

function displayName(name: string, kind: 'file' | 'directory'): string {
  const normalized = name.normalize('NFC').trim()
  const hasReplacementText = normalized.includes('�')
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  if (!normalized || hasReplacementText || hasControlCharacter) {
    return kind === 'directory' ? '未命名文件夹' : '未命名文件'
  }
  return normalized
}

export default function TrashBin() {
  const { masterKey } = useAuth()
  const [items, setItems] = useState<TrashItem[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [purgingId, setPurgingId] = useState<string | null>(null)
  const [purgeProgress, setPurgeProgress] = useState(0)
  const [emptying, setEmptying] = useState(false)
  const busy = restoringId !== null || purgingId !== null || emptying

  const loadTrash = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setLoadError('')
    try {
      const list = await listTrash()
      setItems(list)
      if (masterKey) {
        const next: Record<string, string> = {}
        await Promise.all(list.map(async (item) => {
          next[item.id] = (await resolveDisplayName(masterKey, item)).name
        }))
        setNames(next)
      } else {
        setNames({})
      }
    } catch (error) {
      if (mode === 'initial') setItems([])
      setLoadError(requestErrorMessage(error))
    } finally {
      if (mode === 'initial') setLoading(false)
      else setRefreshing(false)
    }
  }, [masterKey])

  useEffect(() => {
    let active = true
    async function loadInitialTrash() {
      if (!active) return
      await loadTrash()
    }
    void loadInitialTrash()
    return () => {
      active = false
    }
  }, [loadTrash])

  async function handleRestore(item: TrashItem) {
    setRestoringId(item.id)
    setActionError('')
    setNotice('')
    try {
      await restoreTrashItem(item.id)
      const location = item.parent_name ?? '我的云盘'
      setItems((previous) => previous.filter((entry) => entry.id !== item.id))
      setNotice(`已恢复到「${location}」`)
    } catch (error) {
      setActionError(requestErrorMessage(error))
      if (error instanceof FilesRequestError && error.status === 410) void loadTrash('refresh')
    } finally {
      setRestoringId(null)
    }
  }

  async function handlePurge(item: TrashItem) {
    const count = item.item_count ?? 0
    const name = names[item.id] ?? displayName(item.name, item.kind)
    const message = item.kind === 'directory'
      ? `彻底删除后无法恢复，文件夹中的 ${count} 项会一起删除。`
      : `确定永久删除文件“${name}”吗？此操作无法撤销。`
    if (!window.confirm(message)) return
    setPurgingId(item.id)
    setActionError('')
    setNotice('')
    setPurgeProgress(0)
    try {
      const result = await purgeTrashItem(item.id, (done) => setPurgeProgress(done))
      if (result.remaining > 0) {
        setActionError(purgeError(result.error, result.remaining))
      } else {
        setItems((previous) => previous.filter((entry) => entry.id !== item.id))
      }
    } catch (error) {
      setActionError(requestErrorMessage(error))
      if (error instanceof FilesRequestError && error.status === 410) void loadTrash('refresh')
    } finally {
      setPurgingId(null)
      setPurgeProgress(0)
    }
  }

  async function handleEmpty() {
    const count = items.length
    if (!window.confirm(`确定永久删除回收站里的全部 ${count} 项吗？此操作无法撤销。`)) return
    setEmptying(true)
    setActionError('')
    setNotice('')
    try {
      const result = await emptyTrash()
      await loadTrash('refresh')
      if (result.remaining > 0) {
        setActionError(purgeError(result.error, result.remaining))
      } else {
        setNotice('回收站已清空。')
      }
    } catch (error) {
      setActionError(requestErrorMessage(error))
    } finally {
      setEmptying(false)
    }
  }

  return (
    <section className="trash-content" aria-labelledby="trash-heading">
      <div className="trash-toolbar">
        <div>
          <p className="workspace-kicker">TRASH</p>
          <h2 id="trash-heading">已删除的文件</h2>
          <p className="trash-description">删除的文件会保留 30 天，到期后自动永久删除。</p>
        </div>
        <div className="trash-actions">
          {items.length > 0 && (
            <button className="danger-small-button" type="button" onClick={() => void handleEmpty()} disabled={busy}>
              {emptying ? '清空中…' : '清空回收站'}
            </button>
          )}
          <button className="secondary-small-button" type="button" onClick={() => void loadTrash('refresh')} disabled={loading || refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
      {notice && (
        <div className="trash-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')}>关闭</button>
        </div>
      )}
      {actionError && (
        <div className="drive-alert" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')}>关闭</button>
        </div>
      )}
      {loadError && (
        <div className="drive-alert" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadTrash('refresh')}>重试</button>
        </div>
      )}
      <div className="trash-list-panel">
        {loading ? (
          <p className="drive-state" aria-live="polite">正在加载回收站…</p>
        ) : items.length === 0 ? (
          <div className="drive-state">
            <span className="drive-state-icon" aria-hidden="true"><TrashEmptyIcon /></span>
            <h3>回收站是空的</h3>
            <p>删除的文件会在这里保留 30 天。</p>
          </div>
        ) : (
          <div className="drive-grid">
            {items.map((item) => (
              <article className="drive-file-card" key={item.id}>
                <div className="drive-file-heading">
                  <span className="drive-file-icon" aria-hidden="true">
                    {item.kind === 'directory' ? <FolderIcon /> : <FileIcon />}
                  </span>
                  <strong className="drive-file-name" title={names[item.id] ?? displayName(item.name, item.kind)}>{names[item.id] ?? displayName(item.name, item.kind)}</strong>
                </div>
                <div className="drive-file-meta">
                  <span>
                    {item.kind === 'directory'
                      ? `文件夹 · 共 ${item.item_count ?? 0} 项`
                      : `${formatFileSize(item.size_bytes)} · ${item.parent_name ?? '我的云盘'}`}
                  </span>
                  <span>{formatDeletedAt(item.deleted_at)}</span>
                  <span>{daysUntilExpiry(item.expires_at)}</span>
                </div>
                <div className="drive-file-actions">
                  <button type="button" onClick={() => void handleRestore(item)} disabled={busy}>
                    {restoringId === item.id ? '恢复中…' : '恢复'}
                  </button>
                  <button type="button" className="danger-text-button" onClick={() => void handlePurge(item)} disabled={busy}>
                    {purgingId === item.id
                      ? (item.kind === 'directory' ? `已删除 ${purgeProgress} 项` : '删除中…')
                      : '彻底删除'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
