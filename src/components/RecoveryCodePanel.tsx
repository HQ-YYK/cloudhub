import { useState } from 'react'
import { recoveryCodeText } from '../auth/recovery-code'

type RecoveryCodePanelProps = {
  username: string
  display: string
  saved: boolean
  onSavedChange: (saved: boolean) => void
}

export default function RecoveryCodePanel({ username, display, saved, onSavedChange }: RecoveryCodePanelProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(display)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  function handleDownload() {
    const blob = new Blob([recoveryCodeText(username, display)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `cloudhub-恢复码-${username}.txt`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="recovery-code-panel">
      <p className="recovery-code-warning">
        恢复码是忘记密码后找回文件的唯一方式。管理员也无法帮你找回文件。请把它存进密码管理器或打印出来，不要截图发给别人。
      </p>
      <code className="recovery-code-display">{display}</code>
      <div className="recovery-actions">
        <button className="secondary-small-button" type="button" onClick={() => void handleCopy()}>
          {copied ? '已复制' : '复制'}
        </button>
        <button className="secondary-small-button" type="button" onClick={handleDownload}>下载为文本文件</button>
      </div>
      <label className="recovery-code-save">
        <input type="checkbox" checked={saved} onChange={(event) => onSavedChange(event.target.checked)} />
        我已经保存好恢复码
      </label>
    </div>
  )
}
