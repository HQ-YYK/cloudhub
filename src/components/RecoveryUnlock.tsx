import { useState, type FormEvent } from 'react'
import { changePassword, getKeys } from '../api/auth'
import {
  CryptoError,
  deriveFromPassword,
  generateKdfSalt,
  parseRecoveryCode,
  recoveryWrapKey,
  unwrapMasterKey,
  wrapMasterKey,
} from '../crypto'
import { useAuth } from '../auth/useAuth'
import { authErrorMessage } from '../auth/errors'
import SetupEncryption from './SetupEncryption'

export default function RecoveryUnlock() {
  const { user, pendingCredential, completeKeySetup, logout } = useAuth()
  const [recoveryCode, setRecoveryCode] = useState('')
  const [mk, setMk] = useState<Uint8Array<ArrayBuffer> | null>(null)
  const [stage, setStage] = useState<'recovery' | 'password'>('recovery')
  const [done, setDone] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [abandonText, setAbandonText] = useState('')
  const [abandoned, setAbandoned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  if (abandoned) {
    return <SetupEncryption mode="reset" />
  }

  if (!pendingCredential || !('authKey' in pendingCredential)) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="recovery-missing-title">
          <p className="auth-kicker">RECOVERY REQUIRED</p>
          <h1 id="recovery-missing-title">需要重新登录</h1>
          <p className="auth-description">会话里缺少登录凭据，无法继续。请退出后重新登录。</p>
          <div className="totp-switch" style={{ marginTop: 24 }}>
            <button type="button" onClick={() => void logout()}>退出登录</button>
          </div>
        </section>
      </main>
    )
  }

  const currentUser = user
  const currentAuthKey = pendingCredential.authKey

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!recoveryCode.trim()) {
      setError('请输入恢复码')
      return
    }
    setBusy(true)
    try {
      const bytes = parseRecoveryCode(recoveryCode)
      const keys = await getKeys()
      if (!keys.recoveryWrappedKey) {
        setError('账号还没有设置文件加密')
        return
      }
      const masterKey = await unwrapMasterKey(keys.recoveryWrappedKey, await recoveryWrapKey(bytes), currentUser.id)
      setMk(masterKey)
      setStage('password')
    } catch (requestError) {
      if (requestError instanceof CryptoError) {
        setError('恢复码不正确')
      } else {
        setError(authErrorMessage(requestError, '解锁失败，请稍后重试'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function handlePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!mk) {
      setError('请先输入恢复码解锁')
      return
    }
    if (newPassword.length < 12) {
      setError('新密码至少 12 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      const kdfSalt = generateKdfSalt()
      const derived = await deriveFromPassword(newPassword, kdfSalt)
      const wrappedMasterKey = await wrapMasterKey(mk, derived.wrapKey, currentUser.id)
      await changePassword({
        currentAuthKey,
        newKdfSalt: kdfSalt,
        newAuthKey: derived.authKey,
        wrappedMasterKey,
      })
      setDone(true)
    } catch (requestError) {
      setError(authErrorMessage(requestError, '设置密码失败，请稍后重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card is-wide" aria-labelledby="recovery-title">
        <div className="auth-brand">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>CloudHub</span>
        </div>
        <p className="auth-kicker">RECOVER FILES</p>
        <h1 id="recovery-title">用恢复码解锁</h1>
        <p className="auth-description">管理员重置了你的密码。你的文件是用你自己的密钥加密的，需要用恢复码解锁，然后设置新密码。</p>

        {done ? (
          <div className="recovery-code-step">
            <p className="account-success" role="status">已解锁，原来的恢复码仍然有效。</p>
            <button className="login-submit" type="button" onClick={() => completeKeySetup(mk!)}>进入工作台</button>
          </div>
        ) : stage === 'recovery' ? (
          <div>
            <form className="login-form" onSubmit={handleUnlock}>
              <label>
                恢复码
                <input
                  autoComplete="off"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  disabled={busy}
                  placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
                  required
                />
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="login-submit" type="submit" disabled={busy}>
                {busy ? '正在解锁…' : '解锁'}
              </button>
            </form>
            {!abandonOpen && (
              <div className="recovery-code-step">
                <button className="subtle-link" type="button" onClick={() => setAbandonOpen(true)}>我没有恢复码</button>
              </div>
            )}
            {abandonOpen && (
              <div className="recovery-code-step">
                <p className="recovery-code-warning">
                  没有恢复码就无法解开旧的密钥。继续后，你以前上传的所有文件都将永久无法打开，管理员也无法恢复。这个操作不能撤销。
                </p>
                <label>
                  请输入「放弃旧文件」以确认
                  <input
                    value={abandonText}
                    onChange={(event) => setAbandonText(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <div className="password-actions">
                  <button className="danger-small-button" type="button" disabled={busy || abandonText !== '放弃旧文件'} onClick={() => setAbandoned(true)}>
                    确认放弃
                  </button>
                  <button className="secondary-small-button" type="button" disabled={busy} onClick={() => { setAbandonOpen(false); setAbandonText('') }}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <form className="login-form" onSubmit={handlePassword}>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label>
              确认新密码
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="login-submit" type="submit" disabled={busy}>
              {busy ? '正在计算密钥…' : '设置新密码'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
