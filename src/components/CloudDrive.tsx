import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { createDirectory, listFiles, type DriveItem, FilesRequestError } from '../api/files'

type DirectoryLevel = {
  id: string | null
  name: string
}

function requestErrorMessage(error: unknown, action: 'list' | 'create') {
  if (error instanceof FilesRequestError) {
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。'
    if (error.status === 403) return '请求来源未通过安全校验，请刷新页面后重试。'
    if (error.status === 409) return '当前目录中已经存在同名文件夹。'
    if (error.status === 400) return action === 'create' ? '文件夹名称无效，请检查后重试。' : '目录请求无效。'
    if (error.status === 404) return '目录不存在或已不可访问。'
    if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  }
  return action === 'create' ? '文件夹创建失败，请稍后重试。' : '目录加载失败，请稍后重试。'
}

export default function CloudDrive() {
  const [levels, setLevels] = useState<DirectoryLevel[]>([{ id: null, name: '我的云盘' }])
  const [items, setItems] = useState<DriveItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [folderName, setFolderName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
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

  const directories = useMemo(
    () => items.filter((item) => item.kind === 'directory'),
    [items],
  )

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
      {loadError && (
        <div className="drive-alert" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadDirectory(current.id)}>重试</button>
        </div>
      )}
      <div className="drive-list-panel">
        {loading ? (
          <p className="drive-state" aria-live="polite">正在加载目录…</p>
        ) : directories.length === 0 ? (
          <div className="drive-state">
            <span className="drive-state-icon" aria-hidden="true">□</span>
            <h3>这里还没有文件夹</h3>
            <p>创建一个文件夹，开始整理你的云端工作资料。</p>
          </div>
        ) : (
          <div className="drive-grid">
            {directories.map((directory) => (
              <button className="drive-folder-card" type="button" key={directory.id} onClick={() => enterDirectory(directory)}>
                <span className="drive-folder-icon" aria-hidden="true">□</span>
                <span className="drive-folder-name">{directory.name}</span>
                <span className="drive-folder-action">进入目录</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
