import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  createDirectory,
  deleteFile,
  downloadFile,
  listFiles,
  type DriveItem,
  FilesRequestError,
} from '../api/files'

type DirectoryLevel = {
  id: string | null
  name: string
}

function requestErrorMessage(error: unknown, action: 'list' | 'create' | 'download' | 'delete') {
  if (error instanceof FilesRequestError) {
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 409) return '当前目录中已经存在同名文件夹。'
    if (error.status === 404) {
      return action === 'delete' ? '文件不存在或已被删除。' : '目录或文件不存在或已不可访问。'
    }
    if (error.status === 400) {
      return action === 'create' ? '文件夹名称无效，请检查后重试。' : '请求无效，请检查后重试。'
    }
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  const messages = {
    list: '目录加载失败，请稍后重试。',
    create: '文件夹创建失败，请稍后重试。',
    download: '文件下载失败，请稍后重试。',
    delete: '文件删除失败，请稍后重试。',
  } satisfies Record<typeof action, string>
  return messages[action]
}

function formatFileSize(size: number | null) {
  if (size === null) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '更新时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export default function CloudDrive() {
  const [levels, setLevels] = useState<DirectoryLevel[]>([{ id: null, name: '我的云盘' }])
  const [items, setItems] = useState<DriveItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [folderName, setFolderName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const current = levels[levels.length - 1]

  const loadDirectory = useCallback(async (parentId: string | null) => {
    setLoading(true)
    setLoadError('')
    try {
      setItems(await listFiles(parentId))
    } catch (error) {
      setItems([])
      setLoadError(requestErrorMessage(error, 'list'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    async function loadCurrentDirectory() {
      if (!active) return
      await loadDirectory(current.id)
    }
    void loadCurrentDirectory()
    return () => {
      active = false
    }
  }, [current.id, loadDirectory])

  function enterDirectory(directory: DriveItem) {
    setLevels((previous) => [...previous, { id: directory.id, name: directory.name }])
  }

  function goToLevel(index: number) {
    setLevels((previous) => previous.slice(0, index + 1))
  }

  async function handleCreateDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = folderName.trim()
    if (!name) {
      setCreateError('请输入文件夹名称。')
      return
    }

    setCreating(true)
    setCreateError('')
    try {
      await createDirectory(name, current.id)
      setFolderName('')
      await loadDirectory(current.id)
    } catch (error) {
      setCreateError(requestErrorMessage(error, 'create'))
    } finally {
      setCreating(false)
    }
  }

  async function handleDownload(item: DriveItem) {
    setDownloadingId(item.id)
    setActionError('')
    try {
      await downloadFile(item.id)
    } catch (error) {
      setActionError(requestErrorMessage(error, 'download'))
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleDelete(item: DriveItem) {
    if (!window.confirm(`确定删除文件“${item.name}”吗？删除后将无法在当前列表中恢复。`)) return
    setDeletingId(item.id)
    setActionError('')
    try {
      await deleteFile(item.id)
      await loadDirectory(current.id)
    } catch (error) {
      setActionError(requestErrorMessage(error, 'delete'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="drive-content" aria-labelledby="drive-heading">
      <div className="drive-toolbar">
        <div>
          <p className="workspace-kicker">PRIVATE DRIVE</p>
          <h2 id="drive-heading">目录浏览</h2>
          <nav className="drive-breadcrumbs" aria-label="云盘目录路径">
            {levels.map((level, index) => (
              <span key={level.id ?? 'root'}>
                {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">/</span>}
                <button type="button" onClick={() => goToLevel(index)} disabled={index === levels.length - 1}>
                  {level.name}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div className="drive-actions">
          <button className="secondary-small-button" type="button" onClick={() => void loadDirectory(current.id)} disabled={loading}>
            刷新
          </button>
          <form className="new-folder-form" onSubmit={handleCreateDirectory}>
            <label htmlFor="new-folder-name">新建文件夹</label>
            <div className="new-folder-controls">
              <input
                id="new-folder-name"
                value={folderName}
                onChange={(event) => {
                  setFolderName(event.target.value)
                  if (createError) setCreateError('')
                }}
                placeholder="文件夹名称"
                disabled={creating}
                maxLength={255}
              />
              <button className="primary-small-button" type="submit" disabled={creating}>
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
            {createError && <p className="drive-form-error" role="alert">{createError}</p>}
          </form>
        </div>
      </div>
      {actionError && <div className="drive-alert" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>关闭</button></div>}
      {loadError && (
        <div className="drive-alert" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadDirectory(current.id)}>重试</button>
        </div>
      )}
      <div className="drive-list-panel">
        {loading ? (
          <p className="drive-state" aria-live="polite">正在加载目录…</p>
        ) : items.length === 0 ? (
          <div className="drive-state">
            <span className="drive-state-icon" aria-hidden="true">□</span>
            <h3>这里还没有文件</h3>
            <p>创建文件夹，开始整理你的云端工作资料。</p>
          </div>
        ) : (
          <div className="drive-grid">
            {items.map((item) => (
              item.kind === 'directory' ? (
                <button className="drive-folder-card" type="button" key={item.id} onClick={() => enterDirectory(item)}>
                  <span className="drive-folder-icon" aria-hidden="true">□</span>
                  <span className="drive-folder-name">{item.name}</span>
                  <span className="drive-folder-action">进入目录</span>
                </button>
              ) : (
                <article className="drive-file-card" key={item.id}>
                  <div className="drive-file-heading">
                    <span className="drive-file-icon" aria-hidden="true">▤</span>
                    <strong className="drive-file-name" title={item.name}>{item.name}</strong>
                  </div>
                  <div className="drive-file-meta">
                    <span>{formatFileSize(item.size_bytes)} · {item.mime_type ?? '类型未知'}</span>
                    <span>{formatUpdatedAt(item.updated_at)}</span>
                  </div>
                  <div className="drive-file-actions">
                    <button type="button" onClick={() => void handleDownload(item)} disabled={downloadingId !== null || deletingId !== null}>
                      {downloadingId === item.id ? '下载中…' : '下载'}
                    </button>
                    <button type="button" className="danger-text-button" onClick={() => void handleDelete(item)} disabled={downloadingId !== null || deletingId !== null}>
                      {deletingId === item.id ? '删除中…' : '删除'}
                    </button>
                  </div>
                </article>
              )
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
