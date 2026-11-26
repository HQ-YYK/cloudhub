import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import {
  createDirectory,
  deleteFile,
  downloadFile,
  fetchFileRange,
  listFiles,
  renameItem,
  type DriveItem,
} from '../api/files'
import { CryptoError, plainSizeFromCipher } from '../crypto'
import { useAuth } from '../auth/useAuth'
import { DownloadError, downloadEncryptedFile, formatDownloadStatus } from '../files/download'
import { checkName, nameProblemMessage } from '../files/names'
import { buildCreateDirectoryPayload, buildRenamePayload } from '../files/rename'
import { fileKeyFor, resolveDriveItems, type DisplayItem } from '../files/session'
import { EmptyIcon, FileIcon, FolderIcon, MoreIcon, UploadIcon } from './DriveIcons'
import MoveDialog from './MoveDialog'
import RenameInput from './RenameInput'
import ShareDialog from './ShareDialog'
import { UploadQueue, type UploadQueueHandle } from './UploadQueue'
import { formatUpdatedAt, plainSizeLabel, renameErrorMessage, requestErrorMessage } from './drive-format'

type DirectoryLevel = {
  id: string | null
  name: string
}

export default function CloudDrive() {
  const { masterKey } = useAuth()
  const [levels, setLevels] = useState<DirectoryLevel[]>([{ id: null, name: '我的云盘' }])
  const [entries, setEntries] = useState<DisplayItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [folderName, setFolderName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [folderFormOpen, setFolderFormOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [download, setDownload] = useState<{ name: string; receivedBytes: number; totalBytes: number; speedBytesPerSecond: number | null; etaSeconds: number | null; contending: boolean } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  const [moveTarget, setMoveTarget] = useState<DriveItem | null>(null)
  const [shareTarget, setShareTarget] = useState<DriveItem | null>(null)
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null)
  const current = levels[levels.length - 1]
  const uploadQueueRef = useRef<UploadQueueHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentIdRef = useRef(current.id)
  const dragDepthRef = useRef(0)
  const downloadControllerRef = useRef<AbortController | null>(null)
  const cardBusy = downloadingId !== null || deletingId !== null || renamingId !== null || moveTarget !== null || shareTarget !== null

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
      const items = await listFiles(parentId)
      if (masterKey) setEntries(await resolveDriveItems(masterKey, items))
      else setEntries(items.map((item) => ({ item, name: item.enc === 1 ? '无法解密的项目' : item.name, status: item.enc === 1 ? 'failed' : 'plain' })))
    } catch (error) {
      if (mode === 'initial') setEntries([])
      setLoadError(requestErrorMessage(error, 'list'))
    } finally {
      if (mode === 'initial') setLoading(false)
      else setRefreshing(false)
    }
  }, [masterKey])

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

  function enterDirectory(directory: DriveItem, name: string) {
    setLevels((previous) => [...previous, { id: directory.id, name }])
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
    const check = checkName(folderName)
    if (!check.ok) {
      setCreateError(nameProblemMessage(check.problem, check.length))
      return
    }
    if (!masterKey) {
      setCreateError('文件加密密钥尚未就绪，请刷新页面重试。')
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      const payload = await buildCreateDirectoryPayload(masterKey, check.normalized)
      await createDirectory({ id: payload.id, parentId: current.id, encName: payload.encName, nameKey: payload.nameKey })
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
    const entry = entries.find((candidate) => candidate.item.id === item.id)
    const name = entry?.name ?? item.name
    setActionError('')
    setDownloadingId(item.id)
    if (item.enc !== 1) {
      try {
        await downloadFile(item.id)
      } catch (error) {
        setActionError(requestErrorMessage(error, 'download'))
      } finally {
        setDownloadingId(null)
      }
      return
    }
    if (!masterKey || !item.wrappedKey || item.size_bytes === null) {
      setDownloadingId(null)
      setActionError('文件已损坏或被篡改，无法解密')
      return
    }
    const controller = new AbortController()
    downloadControllerRef.current = controller
    try {
      const fk = await fileKeyFor(masterKey, item.id, item.wrappedKey)
      const totalBytes = plainSizeFromCipher(item.size_bytes)
      const contending = uploadQueueRef.current?.isUploading() ?? false
      setDownload({ name, receivedBytes: 0, totalBytes, speedBytesPerSecond: null, etaSeconds: null, contending })
      await downloadEncryptedFile({
        fk,
        fileId: item.id,
        cipherSize: item.size_bytes,
        fileName: name,
        fetchRange: (start, end, signal) => fetchFileRange(item.id, start, end, signal),
        onProgress: (progress) => setDownload({ name, receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes, speedBytesPerSecond: progress.speedBytesPerSecond, etaSeconds: progress.etaSeconds, contending }),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof DownloadError) {
        if (error.code === 'decrypt_failed') setActionError('文件已损坏或被篡改，无法解密')
        else if (error.code === 'too_large') setActionError('文件太大，当前浏览器无法下载，请改用 Chrome 或 Edge')
        else if (error.code === 'incomplete') setActionError('下载不完整，请重试')
      } else if (error instanceof CryptoError && error.code === 'decrypt_failed') {
        setActionError('文件已损坏或被篡改，无法解密')
      } else {
        setActionError(requestErrorMessage(error, 'download'))
      }
    } finally {
      if (downloadControllerRef.current === controller) downloadControllerRef.current = null
      setDownload(null)
      setDownloadingId(null)
    }
  }

  async function handleDelete(item: DriveItem) {
    const entry = entries.find((candidate) => candidate.item.id === item.id)
    const name = entry?.name ?? item.name
    const message = item.kind === 'directory'
      ? `确定把文件夹“${name}”及其中全部内容移到回收站吗？30 天内可以在回收站整体恢复。`
      : `确定把“${name}”移到回收站吗？30 天内可以在回收站恢复。`
    if (!window.confirm(message)) return
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
    if (!masterKey) {
      setActionError('文件加密密钥尚未就绪，请刷新页面重试。')
      return
    }
    setRenameSaving(true)
    setActionError('')
    try {
      const payload = await buildRenamePayload(masterKey, item, name)
      await renameItem(item.id, payload)
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

  function startShare(item: DriveItem) {
    setShareTarget(item)
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
      {download && (
        <div className="drive-download-progress" role="status">
          <span className="drive-download-name">{download.name}</span>
          <span className="drive-download-size">{formatDownloadStatus(download.receivedBytes, download.totalBytes, download.speedBytesPerSecond, download.etaSeconds)}</span>
          <button type="button" onClick={() => downloadControllerRef.current?.abort()}>取消</button>
          {download.contending && <p className="drive-download-note">同时上传和下载会互相抢带宽，速度会变慢。</p>}
          <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={download.totalBytes} aria-valuenow={download.receivedBytes} aria-label="下载进度">
            <span className="upload-progress-fill" style={{ width: `${download.totalBytes > 0 ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)) : 0}%` }} />
          </div>
        </div>
      )}
      {loadError && (
        <div className="drive-alert" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadDirectory(current.id, 'refresh')}>重试</button>
        </div>
      )}
      <UploadQueue ref={uploadQueueRef} onItemDone={handleUploadDone} masterKey={masterKey} />
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
        ) : entries.length === 0 ? (
          <div className="drive-state">
            <span className="drive-state-icon" aria-hidden="true"><EmptyIcon /></span>
            <h3>这里还没有文件</h3>
            <p>拖拽文件到这里，或点击上传文件</p>
          </div>
        ) : (
          <div className="drive-grid">
            {entries.map(({ item, name, status }) => {
              const undecryptable = status === 'failed'
              return item.kind === 'directory' ? (
                <div className="drive-folder-card" key={item.id}>
                  {renamingId === item.id ? (
                    <RenameInput item={item} name={name} saving={renameSaving} onSave={(value) => void handleRenameSave(item, value)} onCancel={cancelRename} />
                  ) : (
                    <button className="drive-folder-main" type="button" onClick={() => enterDirectory(item, name)}>
                      <span className="drive-folder-icon" aria-hidden="true"><FolderIcon /></span>
                      <span className="drive-folder-name">{name}</span>
                      {status === 'plain' && <span className="drive-enc-tag">未加密</span>}
                    </button>
                  )}
                  <div className="drive-folder-more">
                    <button type="button" className="drive-more-button" aria-label={`${name} 更多操作`} onClick={() => toggleFolderMenu(item.id)} disabled={cardBusy}>
                      <MoreIcon />
                    </button>
                    {folderMenuId === item.id && (
                      <div className="drive-folder-menu" role="menu">
                        <button type="button" role="menuitem" disabled={undecryptable} onClick={() => { setFolderMenuId(null); startRename(item) }}>改名</button>
                        <button type="button" role="menuitem" onClick={() => { setFolderMenuId(null); startMove(item) }}>移动</button>
                        <button type="button" role="menuitem" className="danger-text-button" onClick={() => { setFolderMenuId(null); void handleDelete(item) }}>
                          {deletingId === item.id ? '删除中…' : '删除'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <article className="drive-file-card" key={item.id}>
                  <div className="drive-file-heading">
                    <span className="drive-file-icon" aria-hidden="true"><FileIcon /></span>
                    {renamingId === item.id ? (
                      <RenameInput item={item} name={name} saving={renameSaving} onSave={(value) => void handleRenameSave(item, value)} onCancel={cancelRename} />
                    ) : (
                      <strong className="drive-file-name" title={name}>
                        {name}
                        {status === 'plain' && <span className="drive-enc-tag">未加密</span>}
                      </strong>
                    )}
                  </div>
                  <div className="drive-file-meta">
                    <span>{plainSizeLabel(item)}{item.enc !== 1 && ` · ${item.mime_type ?? '类型未知'}`}</span>
                    <span>{formatUpdatedAt(item.updated_at)}</span>
                  </div>
                  <div className="drive-file-actions">
                    <button type="button" onClick={() => void handleDownload(item)} disabled={cardBusy || undecryptable}>
                      {downloadingId === item.id ? '下载中…' : '下载'}
                    </button>
                    <button type="button" onClick={() => startRename(item)} disabled={cardBusy || undecryptable || item.enc === 0} title={item.enc === 0 ? '旧的未加密文件不能改名，请重新上传' : undefined}>改名</button>
                    <button type="button" onClick={() => startMove(item)} disabled={cardBusy}>移动</button>
                    <button type="button" onClick={() => startShare(item)} disabled={cardBusy || undecryptable}>分享</button>
                    <button type="button" className="danger-text-button" onClick={() => void handleDelete(item)} disabled={cardBusy}>
                      {deletingId === item.id ? '删除中…' : '删除'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
      {shareTarget && masterKey && (
        <ShareDialog item={shareTarget} displayName={entries.find((entry) => entry.item.id === shareTarget.id)?.name ?? shareTarget.name} masterKey={masterKey} onClose={() => setShareTarget(null)} />
      )}
      {moveTarget && masterKey && (
        <MoveDialog
          item={moveTarget}
          displayName={entries.find((entry) => entry.item.id === moveTarget.id)?.name ?? moveTarget.name}
          parentName={current.name}
          masterKey={masterKey}
          onClose={() => setMoveTarget(null)}
          onMoved={handleMoveDone}
          onError={(message) => setActionError(message)}
        />
      )}
    </section>
  )
}
