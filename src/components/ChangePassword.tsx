import { useState, type FormEvent } from 'react'
import { changePassword, AuthRequestError } from '../api/auth'
import { useAuth } from '../auth/useAuth'

type ChangePasswordProps = {
  forced?: boolean
}

export default function ChangePassword({ forced = false }: ChangePasswordProps) {
  const { passwordChanged, logout } = useAuth()
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
      await changePassword(currentPassword, newPassword)
      passwordChanged()
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(forced ? '' : '密码已修改，其他设备已退出登录')
    } catch (requestError) {
      if (requestError instanceof AuthRequestError) {
        if (requestError.code === 'invalid_credentials') {
          setError('当前密码不正确，或尝试次数过多，请稍后再试')
        } else if (requestError.code === 'weak_password') {
          setError('新密码至少 12 位，且不能与当前密码相同')
        } else {
          setError('修改密码失败，请稍后重试')
        }
      } else {
        setError('修改密码失败，请稍后重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={forced ? 'forced-password-page' : 'drive-list-panel account-settings-panel'} aria-labelledby="change-password-heading">
      <div className="account-settings-heading">
        <p className="workspace-kicker">ACCOUNT SETTINGS</p>
        <h2 id="change-password-heading">修改密码</h2>
      </div>
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
            {submitting ? '修改中…' : '修改密码'}
          </button>
          {forced && <button className="secondary-small-button" type="button" onClick={() => void logout()}>退出登录</button>}
        </div>
      </form>
    </section>
  )
}
