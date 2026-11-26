import { useCallback, useEffect, useState } from 'react'
import { createShare, listSharesByFile, revokeShare, type ShareView } from '../api/shares'
import type { DriveItem } from '../api/files'
import { resolveShares, type ResolvedShare } from '../files/share'
import ShareLinkRow from './ShareLinkRow'
import { shareErrorMessage } from './share-error'

const EXPIRY_OPTIONS = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: null, label: '永久' },
] as const

type ExpiryDays = 1 | 7 | 30 | null

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function shareWithItemFallback(share: ShareView, item: DriveItem): ShareView {
  return {
    ...share,
    enc: (share.enc ?? item.enc) as 0 | 1,
    encName: share.encName || item.name,
    wrappedKey: share.wrappedKey ?? item.wrappedKey,
  }
}

export default function ShareDialog({ item, displayName, masterKey, onClose }: {
  item: DriveItem
  displayName: string
  masterKey: Uint8Array<ArrayBuffer>
  onClose: () => void
}) {
  const [expiresInDays, setExpiresInDays] = useState<ExpiryDays>(7)
  const [shares, setShares] = useState<ShareView[]>([])
  const [resolved, setResolved] = useState<ResolvedShare[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadShares = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setShares(await listSharesByFile(item.id))
    } catch (error) {
      setLoadError(shareErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [item.id])

  useEffect(() => {
    let active = true
    async function loadInitialShares() {
      if (!active) return
      await loadShares()
    }
    void loadInitialShares()
    return () => {
      active = false
    }
  }, [loadShares])

  useEffect(() => {
    let active = true
    resolveShares(masterKey, shares)
      .then((value) => {
        if (active) setResolved(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [shares, masterKey])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function handleGenerate() {
    setGenerating(true)
    setActionError('')
    try {
      const share = await createShare(item.id, expiresInDays)
      setShares((previous) => [shareWithItemFallback(share, item), ...previous])
      setHighlightId(share.id)
    } catch (error) {
      setActionError(shareErrorMessage(error))
    } finally {
      setGenerating(false)
    }
  }

  async function handleRevoke(share: ShareView) {
    setRevokingId(share.id)
    setActionError('')
    try {
      await revokeShare(share.id)
      setShares((previous) => previous.map((entry) => entry.id === share.id
        ? { ...entry, active: false, revokedAt: new Date().toISOString() }
        : entry))
    } catch (error) {
      setActionError(shareErrorMessage(error))
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="share-dialog-backdrop" onClick={onClose}>
      <div
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="share-dialog-header">
          <h3 id="share-dialog-title">分享“{displayName}”</h3>
          <button type="button" className="share-dialog-close" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        </div>
        <div className="share-dialog-body">
          <div className="share-generate">
            <p className="share-generate-label">链接有效期</p>
            <div className="share-expiry-options" role="radiogroup" aria-label="链接有效期">
              {EXPIRY_OPTIONS.map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  role="radio"
                  aria-checked={expiresInDays === option.value}
                  className={expiresInDays === option.value ? 'share-expiry-option is-selected' : 'share-expiry-option'}
                  onClick={() => setExpiresInDays(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="share-generate-hint">链接里带着解密密钥，拿到完整链接的人都能下载并打开这个文件。请只发给信任的人，必要时设置过期时间。</p>
            <button className="primary-small-button share-generate-button" type="button" onClick={() => void handleGenerate()} disabled={generating}>
              {generating ? '生成中…' : '生成链接'}
            </button>
          </div>
          {actionError && <div className="drive-alert" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>关闭</button></div>}
          <div className="share-list-heading">
            <h4>已有链接</h4>
            {loading && <span className="share-list-loading">正在加载…</span>}
          </div>
          {loadError ? (
            <div className="drive-alert" role="alert"><span>{loadError}</span><button type="button" onClick={() => void loadShares()}>重试</button></div>
          ) : resolved.length === 0 && !loading ? (
            <p className="share-empty">还没有分享链接，选择有效期后点击「生成链接」。</p>
          ) : (
            <ul className="share-list">
              {resolved.map(({ share, name, fullUrl }) => (
                <ShareLinkRow
                  key={share.id}
                  share={share}
                  name={name}
                  url={fullUrl}
                  highlight={share.id === highlightId}
                  revoking={revokingId === share.id}
                  onRevoke={() => void handleRevoke(share)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
