import { useRef, useState } from 'react'
import type { ShareView } from '../api/shares'

function formatShareExpiry(expiresAt: string | null): string {
  if (!expiresAt) return '永久有效'
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return '有效期未知'
  return `有效期至 ${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)}`
}

function shareStatus(share: ShareView): { label: string; className: string } {
  if (share.revokedAt) return { label: '已撤销', className: 'is-revoked' }
  if (!share.active) return { label: '已过期', className: 'is-expired' }
  return { label: '有效', className: 'is-active' }
}

export default function ShareLinkRow({ share, highlight, revoking, onRevoke }: {
  share: ShareView
  highlight?: boolean
  revoking: boolean
  onRevoke: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState('')
  const status = shareStatus(share)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(share.url)
      setNotice('已复制')
    } catch {
      setNotice('复制失败，请手动复制')
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }

  return (
    <li className={`share-row${highlight ? ' is-new' : ''}`}>
      <div className="share-row-top">
        <span className="share-row-name" title={share.fileName}>{share.fileName}</span>
        <span className={`share-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="share-row-meta">
        <span>{formatShareExpiry(share.expiresAt)}</span>
        <span>{share.downloadCount} 次下载</span>
        {highlight && <span className="share-row-new-badge">新链接</span>}
      </div>
      <div className="share-row-link">
        <input
          ref={inputRef}
          readOnly
          value={share.url}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="分享链接"
        />
        <button type="button" onClick={() => void handleCopy()}>复制</button>
        {share.active && (
          <button type="button" className="danger-text-button" onClick={onRevoke} disabled={revoking}>
            {revoking ? '撤销中…' : '撤销'}
          </button>
        )}
      </div>
      {notice && <span className="share-row-notice" role="status">{notice}</span>}
    </li>
  )
}
