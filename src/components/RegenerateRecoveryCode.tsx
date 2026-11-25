import { useState, type FormEvent } from 'react'
import { regenerateRecoveryKey } from '../api/auth'
import { generateRecoveryKey, recoveryWrapKey, wrapMasterKey } from '../crypto'
import { useAuth } from '../auth/useAuth'
import { credentialFor } from '../auth/credential'
import { authErrorMessage } from '../auth/errors'
import RecoveryCodePanel from './RecoveryCodePanel'

export default function RegenerateRecoveryCode() {
  const { user, masterKey } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [currentAuthKey, setCurrentAuthKey] = useState('')
  const [recovery, setRecovery] = useState<{ bytes: Uint8Array<ArrayBuffer>; display: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  if (!user || !masterKey) return null

  const currentUser = user
  const currentMasterKey = masterKey

  async function handleNext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!currentPassword) {
      setError('请输入当前密码')
      return
    }
    setBusy(true)
    try {
      const credential = await credentialFor(currentUser.username, currentPassword)
      if (!('authKey' in credential)) {
        setError('当前账号格式不支持重新生成恢复码')
        return
      }
      setCurrentAuthKey(credential.authKey)
      setRecovery(generateRecoveryKey())
      setSaved(false)
    } catch (requestError) {
      setError(authErrorMessage(requestError, '生成恢复码失败，请稍后重试'))
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm() {
    setError('')
    setSuccess('')
    if (!recovery || !currentAuthKey) {
      setError('请先输入当前密码生成恢复码')
      return
    }
    setBusy(true)
    try {
      const recoveryWrappedKey = await wrapMasterKey(currentMasterKey, await recoveryWrapKey(recovery.bytes), currentUser.id)
      await regenerateRecoveryKey({ currentAuthKey, recoveryWrappedKey })
      setSuccess('已生成新的恢复码，旧的恢复码已失效')
      setCurrentPassword('')
      setCurrentAuthKey('')
      setRecovery(null)
      setSaved(false)
    } catch {
      setError('提交失败，旧恢复码仍然有效')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="drive-list-panel account-settings-panel" aria-labelledby="regenerate-recovery-heading">
      <div className="account-settings-heading">
        <p className="workspace-kicker">RECOVERY CODE</p>
        <h2 id="regenerate-recovery-heading">重新生成恢复码</h2>
      </div>
      <p className="totp-description">生成后旧的恢复码立即失效。</p>

      {recovery ? (
        <div className="recovery-code-step">
          <RecoveryCodePanel username={currentUser.username} display={recovery.display} saved={saved} onSavedChange={setSaved} />
          <button className="primary-small-button" type="button" disabled={busy || !saved} onClick={() => void handleConfirm()}>
            {busy ? '正在提交…' : '确认生成'}
          </button>
        </div>
      ) : (
        <form className="password-form" onSubmit={(event) => void handleNext(event)}>
          <label>当前密码
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} />
          </label>
          <div className="password-actions">
            <button className="primary-small-button" type="submit" disabled={busy}>
              {busy ? '正在计算密钥…' : '下一步'}
            </button>
          </div>
        </form>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="account-success" role="status">{success}</p>}
    </section>
  )
}
