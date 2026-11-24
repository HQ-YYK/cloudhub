import { useCallback, useEffect, useState } from 'react'
import { getPublicShare, SharesRequestError, type PublicShareMetadata } from '../api/shares'

function formatFileSize(size: number | null) {
  if (size === null) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatExpiry(expiresAt: string | null) {
  if (!expiresAt) return '永久有效'
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

// Mirrors the server's inline allowlist in functions/_lib/http.ts (text/plain excluded on purpose).
const PREVIEW_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'application/pdf',
])

function canPreview(mimeType: string | null) {
  if (!mimeType) return false
  return PREVIEW_TYPES.has(mimeType.split(';')[0].trim().toLowerCase())
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">
      <path d="M6.25 2.75h7.5l4 4v14.5H6.25a1.5 1.5 0 0 1-1.5-1.5V4.25a1.5 1.5 0 0 1 1.5-1.5Z" fill="#f0edff" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M13.75 2.75v4.25h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8 11.25h8M8 14.75h8M8 18.25h5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export default function PublicShare({ token }: { token: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading')
  const [metadata, setMetadata] = useState<PublicShareMetadata | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setStatus('notfound')
      return
    }
    setStatus('loading')
    try {
      setMetadata(await getPublicShare(token))
      setStatus('ready')
    } catch (error) {
      if (error instanceof SharesRequestError && error.status === 404) setStatus('notfound')
      else setStatus('error')
    }
  }, [token])

  useEffect(() => {
    let active = true
    async function loadInitialShare() {
      if (!active) return
      await load()
    }
    void loadInitialShare()
    return () => {
      active = false
    }
  }, [load])

  const downloadUrl = `/api/public/shares/${encodeURIComponent(token)}/download`
  const inlineUrl = `${downloadUrl}?inline=1`

  return (
    <main className="public-share-page">
      {status === 'loading' && <p className="public-share-state" aria-live="polite">正在加载分享…</p>}
      {status === 'notfound' && (
        <div className="public-share-card">
          <span className="public-share-icon"><FileIcon /></span>
          <h1>链接不存在或已失效</h1>
          <p>请确认链接是否正确，或联系分享者重新生成。</p>
        </div>
      )}
      {status === 'error' && (
        <div className="public-share-card">
          <span className="public-share-icon"><FileIcon /></span>
          <h1>加载失败</h1>
          <p>暂时无法访问这个分享，请稍后重试。</p>
          <button className="primary-small-button" type="button" onClick={() => void load()}>重试</button>
        </div>
      )}
      {status === 'ready' && metadata && (
        <div className="public-share-card">
          <span className="public-share-icon"><FileIcon /></span>
          <h1>{metadata.name}</h1>
          <dl className="public-share-meta">
            <div><dt>大小</dt><dd>{formatFileSize(metadata.sizeBytes)}</dd></div>
            <div><dt>到期时间</dt><dd>{formatExpiry(metadata.expiresAt)}</dd></div>
          </dl>
          <div className="public-share-actions">
            <a className="primary-small-button public-share-download" href={downloadUrl}>下载</a>
            {canPreview(metadata.mimeType) && (
              <a className="secondary-small-button" href={inlineUrl} target="_blank" rel="noreferrer">预览</a>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
