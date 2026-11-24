import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import {
  createDirectory,
  deleteFile,
  downloadFile,
  listFiles,
  renameItem,
  type DriveItem,
  FilesRequestError,
} from '../api/files'
import { EmptyIcon, FileIcon, FolderIcon, MoreIcon, UploadIcon } from './DriveIcons'
import MoveDialog from './MoveDialog'
import RenameInput from './RenameInput'
import { UploadQueue, type UploadQueueHandle } from './UploadQueue'

type DirectoryLevel = {
  id: string | null
  name: string
}

function requestErrorMessage(error: unknown, action: 'list' | 'create' | 'download' | 'delete') {
  if (error instanceof FilesRequestError) {
    if (error.code === 'password_change_required') return '请先修改密码'
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

function renameErrorMessage(error: unknown) {
  if (error instanceof FilesRequestError) {
    if (error.code === 'conflict') return '目标位置已有同名文件或文件夹'
    if (error.code === 'invalid_move') return '不能移动到它自己的子文件夹里'
    if (error.code === 'not_ready') return '文件还没上传完成'
    if (error.code === 'invalid_name') return '名称无效，请检查后重试。'
    if (error.code === 'password_change_required') return '请先修改密码'
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 404) return '目录或文件不存在或已不可访问。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return '重命名失败，请稍后重试。'
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

function displayItemName(name: string, kind: 'file' | 'directory') {
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

export default function CloudDrive() {
  const [levels, setLevels] = useState<DirectoryLevel[]>([{ id: null, name: '我的云盘' }])
  const [items, setItems] = useState<DriveItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [folderName, setFolderName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [folderFormOpen, setFolderFormOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  const [moveTarget, setMoveTarget] = useState<DriveItem | null>(null)
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null)
  const current = levels[levels.length - 1]
  const uploadQueueRef = useRef<UploadQueueHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentIdRef = useRef(current.id)
  const dragDepthRef = useRef(0)
  const cardBusy = downloadingId !== null || deletingId !== null || renamingId !== null || moveTarget !== null

  useEffect(() => {
    currentIdRef.current = current.id
  }, [current.id])

  useEffect(() => {
    if (!folderFormOpen || creating) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setFolderFormOpen(false)
        setFolderName('')
        setCreateError('')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [folderFormOpen, creating])

  useEffect(() => {
    if (!folderMenuId) return
    function handleDocumentMouseDown(event: MouseEvent) {
      const target = event.target as Element | null
      if (!target?.closest('.drive-folder-more')) setFolderMenuId(null)
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setFolderMenuId(null)
    }
    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('keydown', handleDocumentKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('keydown', handleDocumentKeyDown)
    }
  }, [folderMenuId])

  const loadDirectory = useCallback(async (parentId: string | null, mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setLoadError('')
    try {
      setItems(await listFiles(parentId))
    } catch (error) {
      if (mode === 'initial') setItems([])
      setLoadError(requestErrorMessage(error, 'list'))
    } finally {
      if (mode === 'initial') setLoading(false)
      else setRefreshing(false)
    }
  }, [])

  const handleUploadDone = useCallback((parentId: string | null) => {
    if (parentId === currentIdRef.current) void loadDirectory(currentIdRef.current, 'refresh')
  }, [loadDirectory])

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

  function openFolderForm() {
    setFolderFormOpen(true)
    setCreateError('')
  }

  function closeFolderForm() {
    setFolderFormOpen(false)
    setFolderName('')
    setCreateError('')
  }

  function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) uploadQueueRef.current?.enqueue(files, current.id)
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepthRef.current -= 1
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setDragOver(false)
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) uploadQueueRef.current?.enqueue(files, current.id)
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
      setFolderFormOpen(false)
      await loadDirectory(current.id, 'refresh')
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
    if (!window.confirm(`确定把“${item.name}”移到回收站吗？30 天内可以在回收站恢复。`)) return
    setDeletingId(item.id)
    setActionError('')
    try {
      await deleteFile(item.id)
      await loadDirectory(current.id, 'refresh')
    } catch (error) {
      setActionError(requestErrorMessage(error, 'delete'))
    } finally {
      setDeletingId(null)
    }
  }

  function startRename(item: DriveItem) {
    setRenamingId(item.id)
    setActionError('')
    setFolderMenuId(null)
  }

  function cancelRename() {
    setRenamingId(null)
    setRenameSaving(false)
  }

  async function handleRenameSave(item: DriveItem, name: string) {
    setRenameSaving(true)
    setActionError('')
    try {
      await renameItem(item.id, name)
      setRenamingId((active) => (active === item.id ? null : active))
      await loadDirectory(current.id, 'refresh')
    } catch (error) {
      setRenamingId((active) => (active === item.id ? null : active))
      setActionError(renameErrorMessage(error))
    } finally {
      setRenameSaving(false)
    }
  }

  function startMove(item: DriveItem) {
    setMoveTarget(item)
    setFolderMenuId(null)
    setActionError('')
  }

  function handleMoveDone() {
    setMoveTarget(null)
    void loadDirectory(current.id, 'refresh')
  }

  function toggleFolderMenu(id: string) {
    setFolderMenuId((active) => (active === id ? null : id))
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
          <button className="primary-small-button upload-file-button" type="button" onClick={() => fileInputRef.current?.click()}>
            <UploadIcon />
            <span>上传文件</span>
          </button>
          <input ref={fileInputRef} type="file" multiple className="visually-hidden" onChange={handleFileSelect} />
          <button className="secondary-small-button" type="button" onClick={openFolderForm}>新建文件夹</button>
          <button className="secondary-small-button" type="button" onClick={() => void loadDirectory(current.id, 'refresh')} disabled={loading || refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
      {folderFormOpen && (
        <form className="new-folder-form" onSubmit={handleCreateDirectory}>
          <div className="new-folder-controls">
            <input
              id="new-folder-name"
              value={folderName}
              onChange={(event) => {
                setFolderName(event.target.value)
                if (createError) setCreateError('')
              }}
              placeholder="文件夹名称"
              aria-label="文件夹名称"
              disabled={creating}
              maxLength={255}
              autoFocus
            />
            <button className="primary-small-button" type="submit" disabled={creating}>
              {creating ? '创建中…' : '创建'}
            </button>
            <button className="secondary-small-button" type="button" onClick={closeFolderForm} disabled={creating}>取消</button>
          </div>
          {createError && <p className="drive-form-error" role="alert">{createError}</p>}
        </form>
      )}
      {actionError && <div className="drive-alert" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>关闭</button></div>}
      {loadError && (
        <div className="drive-alert" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadDirectory(current.id, 'refresh')}>重试</button>
        </div>
      )}
      <UploadQueue ref={uploadQueueRef} onItemDone={handleUploadDone} />
      <div
        className="drive-list-panel"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="drive-drop-overlay" aria-hidden="true">
            松开即可上传到「{current.name}」
          </div>
        )}
        {loading ? (
          <p className="drive-state" aria-live="polite">正在加载目录…</p>
        ) : items.length === 0 ? (
          <div className="drive-state">
            <span className="drive-state-icon" aria-hidden="true"><EmptyIcon /></span>
            <h3>这里还没有文件</h3>
            <p>拖拽文件到这里，或点击上传文件</p>
          </div>
        ) : (
          <div className="drive-grid">
            {items.map((item) => (
              item.kind === 'directory' ? (
                <div className="drive-folder-card" key={item.id}>
                  {renamingId === item.id ? (
                    <RenameInput item={item} saving={renameSaving} onSave={(name) => void handleRenameSave(item, name)} onCancel={cancelRename} />
                  ) : (
                    <button className="drive-folder-main" type="button" onClick={() => enterDirectory(item)}>
                      <span className="drive-folder-icon" aria-hidden="true"><FolderIcon /></span>
                      <span className="drive-folder-name">{displayItemName(item.name, 'directory')}</span>
                    </button>
                  )}
                  <div className="drive-folder-more">
                    <button type="button" className="drive-more-button" aria-label={`${item.name} 更多操作`} onClick={() => toggleFolderMenu(item.id)} disabled={cardBusy}>
                      <MoreIcon />
                    </button>
                    {folderMenuId === item.id && (
                      <div className="drive-folder-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setFolderMenuId(null); startRename(item) }}>改名</button>
                        <button type="button" role="menuitem" onClick={() => { setFolderMenuId(null); startMove(item) }}>移动</button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <article className="drive-file-card" key={item.id}>
                  <div className="drive-file-heading">
                    <span className="drive-file-icon" aria-hidden="true"><FileIcon /></span>
                    {renamingId === item.id ? (
                      <RenameInput item={item} saving={renameSaving} onSave={(name) => void handleRenameSave(item, name)} onCancel={cancelRename} />
                    ) : (
                      <strong className="drive-file-name" title={displayItemName(item.name, 'file')}>{displayItemName(item.name, 'file')}</strong>
                    )}
                  </div>
                  <div className="drive-file-meta">
                    <span>{formatFileSize(item.size_bytes)} · {item.mime_type ?? '类型未知'}</span>
                    <span>{formatUpdatedAt(item.updated_at)}</span>
                  </div>
                  <div className="drive-file-actions">
                    <button type="button" onClick={() => void handleDownload(item)} disabled={cardBusy}>
                      {downloadingId === item.id ? '下载中…' : '下载'}
                    </button>
                    <button type="button" onClick={() => startRename(item)} disabled={cardBusy}>改名</button>
                    <button type="button" onClick={() => startMove(item)} disabled={cardBusy}>移动</button>
                    <button type="button" className="danger-text-button" onClick={() => void handleDelete(item)} disabled={cardBusy}>
                      {deletingId === item.id ? '删除中…' : '删除'}
                    </button>
                  </div>
                </article>
              )
            ))}
          </div>
        )}
      </div>
      {moveTarget && (
        <MoveDialog
          item={moveTarget}
          parentName={current.name}
          onClose={() => setMoveTarget(null)}
          onMoved={handleMoveDone}
          onError={(message) => setActionError(message)}
        />
      )}
    </section>
  )
}
