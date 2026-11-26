import { useEffect, useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { clearDeviceKeys, hasDeviceKeys } from '../auth/device-keys'

export default function DeviceTrust() {
  const { user } = useAuth()
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    if (!user) return
    hasDeviceKeys(user.id)
      .then((value) => {
        if (active) setEnabled(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [user])

  async function handleDisable() {
    if (!user) return
    setBusy(true)
    setNotice('')
    try {
      await clearDeviceKeys(user.id)
      setEnabled(false)
      setNotice('已取消这台设备的保持解锁')
    } finally {
      setBusy(false)
    }
  }

  if (!user) return null

  return (
    <section className="drive-list-panel account-settings-panel" aria-labelledby="device-trust-heading">
      <div className="account-settings-heading">
        <p className="workspace-kicker">THIS DEVICE</p>
        <h2 id="device-trust-heading">这台设备</h2>
      </div>
      <p className="totp-description">保持解锁后，刷新页面不需要重新输入密码。公共电脑或别人的电脑上请不要开启。</p>
      <div className="device-trust-actions">
        <span className={enabled ? 'device-trust-status is-on' : 'device-trust-status'}>{enabled ? '已保持解锁' : '未保持解锁'}</span>
        {enabled && (
          <button className="secondary-small-button" type="button" onClick={() => void handleDisable()} disabled={busy}>
            取消这台设备的保持解锁
          </button>
        )}
      </div>
      {notice && <p className="account-success" role="status">{notice}</p>}
    </section>
  )
}
