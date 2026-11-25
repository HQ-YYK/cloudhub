import { useState, type FormEvent } from 'react'
import { changePassword } from '../api/auth'
import { deriveFromPassword, generateKdfSalt, wrapMasterKey } from '../crypto'
import { useAuth } from '../auth/useAuth'
import { credentialFor } from '../auth/credential'
import { authErrorMessage } from '../auth/errors'

export default function ChangePassword() {
  const { user, masterKey, passwordChanged } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!user || !masterKey) {
      setError('请先解锁后再修改密码')
      return
    }
    if (!currentPassword) {
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
    if (newPassword === currentPassword) {
      setError('新密码不能与当前密码相同')
      return
    }

    setSubmitting(true)
    try {
      const credential = await credentialFor(user.username, currentPassword)
      const kdfSalt = generateKdfSalt()
      const derived = await deriveFromPassword(newPassword, kdfSalt)
      const wrappedMasterKey = await wrapMasterKey(masterKey, derived.wrapKey, user.id)
      await changePassword({
        currentAuthKey: credential.authKey,
        newKdfSalt: kdfSalt,
        newAuthKey: derived.authKey,
        wrappedMasterKey,
      })
      passwordChanged()
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess('密码已修改，其他设备已退出登录')
    } catch (requestError) {
      setError(authErrorMessage(requestError, '修改密码失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="drive-list-panel account-settings-panel" aria-labelledby="change-password-heading">
      <div className="account-settings-heading">
        <p className="workspace-kicker">ACCOUNT SETTINGS</p>
        <h2 id="change-password-heading">修改密码</h2>
      </div>
      <p className="totp-description">忘记密码时只能用恢复码找回文件，请确认你还保存着恢复码。</p>
      <form className="password-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>当前密码
          <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={submitting} />
        </label>
        <label>新密码
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={submitting} />
        </label>
        <label>确认新密码
          <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={submitting} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="account-success" role="status">{success}</p>}
        <div className="password-actions">
          <button className="primary-small-button" type="submit" disabled={submitting}>
            {submitting ? '正在计算密钥…' : '修改密码'}
          </button>
        </div>
      </form>
    </section>
  )
}
