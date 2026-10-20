import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'

export default function LoginPage() {
  const { login, error: sessionError, clearError } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    clearError()
    setSubmitting(true)
    try {
      await login(username.trim(), password)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-brand">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>CloudHub</span>
        </div>
        <p className="auth-kicker">PERSONAL CLOUD WORKSPACE</p>
        <h1 id="login-title">欢迎回到你的工作台</h1>
        <p className="auth-description">登录后继续管理你的项目、实验与长期积累。</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            用户名
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
          </label>
          {(error || sessionError) && <p className="form-error" role="alert">{error || sessionError}</p>}
          <button className="login-submit" type="submit" disabled={submitting}>
            {submitting ? '正在登录…' : '登录 CloudHub'}
          </button>
        </form>
        <p className="auth-note">仅限已配置的 CloudHub 账号使用</p>
      </section>
    </main>
  )
}
