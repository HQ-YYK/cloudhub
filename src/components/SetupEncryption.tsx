import { useState, type FormEvent } from 'react'
import { changePassword, resetKeys } from '../api/auth'
import {
  deriveFromPassword,
  generateKdfSalt,
  generateMasterKey,
  generateRecoveryKey,
  recoveryWrapKey,
  wrapMasterKey,
} from '../crypto'
import { useAuth } from '../auth/useAuth'
import { credentialFor, type AccountCredential } from '../auth/credential'
import { authErrorMessage } from '../auth/errors'
import RecoveryCodePanel from './RecoveryCodePanel'

type SetupEncryptionProps = {
  mode: 'password' | 'reset'
}

export default function SetupEncryption({ mode }: SetupEncryptionProps) {
  const { user, pendingCredential, completeKeySetup, logout } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [currentCredential, setCurrentCredential] = useState<AccountCredential | null>(pendingCredential)
  const [stage, setStage] = useState<'credentials' | 'recovery'>('credentials')
  const [newKdfSalt, setNewKdfSalt] = useState('')
  const [newAuthKey, setNewAuthKey] = useState('')
  const [newWrapKey, setNewWrapKey] = useState<CryptoKey | null>(null)
  const [mk, setMk] = useState<Uint8Array<ArrayBuffer> | null>(null)
  const [recovery, setRecovery] = useState<{ bytes: Uint8Array<ArrayBuffer>; display: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  if (mode === 'reset' && (!pendingCredential || !('authKey' in pendingCredential))) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="reset-missing-title">
          <p className="auth-kicker">RECOVERY REQUIRED</p>
          <h1 id="reset-missing-title">需要重新登录</h1>
          <p className="auth-description">会话里缺少登录凭据，无法继续。请退出后重新登录。</p>
          <div className="totp-switch" style={{ marginTop: 24 }}>
            <button type="button" onClick={() => void logout()}>退出登录</button>
          </div>
        </section>
      </main>
    )
  }

  const currentUser = user
  const needsCurrentPassword = mode === 'password' && !currentCredential
  const isLegacy = currentCredential ? 'password' in currentCredential : currentUser.legacy
  const currentPasswordForCompare = currentCredential && 'password' in currentCredential
    ? currentCredential.password
    : currentPassword

  async function handleNext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (needsCurrentPassword && !currentPassword) {
      setError('请输入当前密码')
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
    if (isLegacy && newPassword === currentPasswordForCompare) {
      setError('新密码不能与当前密码相同')
      return
    }

    setBusy(true)
    try {
      let credential = currentCredential
      if (!credential) {
        credential = await credentialFor(currentUser.username, currentPassword)
        setCurrentCredential(credential)
      }
      const kdfSalt = generateKdfSalt()
      const derived = await deriveFromPassword(newPassword, kdfSalt)
      setNewKdfSalt(kdfSalt)
      setNewAuthKey(derived.authKey)
      setNewWrapKey(derived.wrapKey)
      setMk(generateMasterKey())
      setRecovery(generateRecoveryKey())
      setSaved(false)
      setStage('recovery')
    } catch (requestError) {
      setError(authErrorMessage(requestError, '生成密钥失败，请稍后重试'))
    } finally {
      setBusy(false)
    }
  }

  async function handleComplete() {
    setError('')
    if (!currentCredential || !newWrapKey || !mk || !recovery || !newKdfSalt) {
      setError('设置尚未完成，请重试')
      return
    }
    setBusy(true)
    try {
      const wrappedMasterKey = await wrapMasterKey(mk, newWrapKey, currentUser.id)
      const recoveryWrappedKey = await wrapMasterKey(mk, await recoveryWrapKey(recovery.bytes), currentUser.id)

      if (mode === 'reset') {
        if (!('authKey' in currentCredential)) {
          setError('设置尚未完成，请重试')
          return
        }
        await resetKeys({
          currentAuthKey: currentCredential.authKey,
          newKdfSalt,
          newAuthKey,
          wrappedMasterKey,
          recoveryWrappedKey,
        })
      } else {
        const currentBody = 'password' in currentCredential
          ? { currentPassword: currentCredential.password }
          : { currentAuthKey: currentCredential.authKey }
        await changePassword({
          ...currentBody,
          newKdfSalt,
          newAuthKey,
          wrappedMasterKey,
          recoveryWrappedKey,
        })
      }
      completeKeySetup(mk)
    } catch (requestError) {
      setError(authErrorMessage(requestError, mode === 'reset' ? '重置失败，请稍后重试' : '设置文件加密失败，请稍后重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card is-wide" aria-labelledby="setup-title">
        <div className="auth-brand">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>CloudHub</span>
        </div>
        <p className="auth-kicker">FILE ENCRYPTION</p>
        <h1 id="setup-title">设置文件加密</h1>
        <p className="auth-description">从现在起文件会在你的浏览器里加密后再上传，服务器和管理员都无法查看。</p>

        {stage === 'credentials' ? (
          <form className="login-form" onSubmit={handleNext}>
            {needsCurrentPassword && (
              <label>
                当前密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  disabled={busy}
                  required
                />
              </label>
            )}
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
              {busy ? '正在计算密钥…' : '下一步'}
            </button>
          </form>
        ) : (
          <div className="recovery-code-step">
            {recovery && <RecoveryCodePanel username={currentUser.username} display={recovery.display} saved={saved} onSavedChange={setSaved} />}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="login-submit" type="button" disabled={busy || !saved} onClick={() => void handleComplete()}>
              {busy ? '正在保存…' : '完成设置'}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
