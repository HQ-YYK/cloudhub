import { useCallback, useEffect, useState } from 'react'
import { listShares, revokeShare, type ShareView } from '../api/shares'
import { useAuth } from '../auth/useAuth'
import { resolveShares, type ResolvedShare } from '../files/share'
import ShareLinkRow from './ShareLinkRow'
import { shareErrorMessage } from './share-error'

function ShareEmptyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      <path d="M12 15.25V4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 8 12 4.5 15.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 13.25v4.5A1.75 1.75 0 0 0 7.75 19.5h8.5a1.75 1.75 0 0 0 1.75-1.75v-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function MyShares() {
  const { masterKey } = useAuth()
  const [shares, setShares] = useState<ShareView[]>([])
  const [resolved, setResolved] = useState<ResolvedShare[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadShares = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setLoadError('')
    try {
      setShares(await listShares())
    } catch (error) {
      if (mode === 'initial') setShares([])
      setLoadError(shareErrorMessage(error))
    } finally {
      if (mode === 'initial') setLoading(false)
      else setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!masterKey) return
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
    <section className="share-content" aria-labelledby="shares-heading">
      <div className="share-toolbar">
        <div>
          <p className="workspace-kicker">SHARES</p>
          <h2 id="shares-heading">我的分享</h2>
          <p className="share-description">管理你分享出去的文件链接，随时可以复制或撤销。</p>
        </div>
        <div className="share-actions">
          <button className="secondary-small-button" type="button" onClick={() => void loadShares('refresh')} disabled={loading || refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
      {actionError && <div className="drive-alert" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>关闭</button></div>}
      {loadError && (
        <div className="drive-alert" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadShares('refresh')}>重试</button>
        </div>
      )}
      <div className="share-list-panel">
        {loading ? (
          <p className="drive-state" aria-live="polite">正在加载分享…</p>
        ) : resolved.length === 0 ? (
          <div className="drive-state">
            <span className="drive-state-icon" aria-hidden="true"><ShareEmptyIcon /></span>
            <h3>还没有分享过文件</h3>
            <p>在私有云盘里选择文件，点击「分享」生成链接。</p>
          </div>
        ) : (
          <ul className="share-list">
            {resolved.map(({ share, name, fullUrl }) => (
              <ShareLinkRow
                key={share.id}
                share={share}
                name={name}
                url={fullUrl}
                revoking={revokingId === share.id}
                onRevoke={() => void handleRevoke(share)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
