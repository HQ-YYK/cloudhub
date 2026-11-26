import { useState, type FormEvent } from 'react'
import { getKeys } from '../api/auth'
import { CryptoError, unwrapMasterKey } from '../crypto'
import { useAuth } from '../auth/useAuth'
import { credentialFor } from '../auth/credential'
import { authErrorMessage } from '../auth/errors'
import { clearDeviceKeys, storeDeviceKeys } from '../auth/device-keys'

export default function UnlockPage() {
  const { user, setMasterKey, logout } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keepUnlocked, setKeepUnlocked] = useState(true)

  if (!user) return null

  const currentUser = user

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!password) {
      setError('请输入密码')
      return
    }
    setBusy(true)
    try {
      const credential = await credentialFor(currentUser.username, password)
      if (!('wrapKey' in credential)) {
        setError('账号格式不支持，请退出后重新登录')
        return
      }
      const keys = await getKeys()
      if (!keys.wrappedMasterKey) {
        setError('账号还没有设置文件加密')
        return
      }
      const mk = await unwrapMasterKey(keys.wrappedMasterKey, credential.wrapKey, currentUser.id)
      setMasterKey(mk)
      if (keepUnlocked) void storeDeviceKeys(currentUser.id, mk).catch(() => {})
      else void clearDeviceKeys(currentUser.id).catch(() => {})
    } catch (requestError) {
      if (requestError instanceof CryptoError && requestError.code === 'decrypt_failed') {
        setError('密码不正确')
      } else {
        setError(authErrorMessage(requestError, '解锁失败，请稍后重试'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="unlock-title">
        <div className="auth-brand">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>CloudHub</span>
        </div>
        <p className="auth-kicker">UNLOCK WORKSPACE</p>
        <h1 id="unlock-title">解锁你的工作台</h1>
        <p className="auth-description">为了保护你的文件，密钥只保存在当前页面里。刷新或重新打开页面后需要再输入一次密码。</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
          </label>
          <label className="keep-unlocked-row">
            <span className="keep-unlocked-label">
              <input type="checkbox" checked={keepUnlocked} onChange={(event) => setKeepUnlocked(event.target.checked)} disabled={busy} />
              <span>在这台设备上保持解锁</span>
            </span>
            <span className="keep-unlocked-hint">公共电脑或别人的电脑上请不要勾选</span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="login-submit" type="submit" disabled={busy}>
            {busy ? '正在计算密钥…' : '解锁'}
          </button>
        </form>
        <div className="totp-switch" style={{ marginTop: 20 }}>
          <button type="button" onClick={() => void logout()} disabled={busy}>退出登录</button>
        </div>
      </section>
    </main>
  )
}
