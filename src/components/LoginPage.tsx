import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'

export default function LoginPage() {
  const { login, verifyTotp, error: sessionError, clearError } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState<string | null>(null)
  const [totpMode, setTotpMode] = useState<'code' | 'recovery'>('code')
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [keepUnlocked, setKeepUnlocked] = useState(true)

  function resetErrors() {
    setError('')
    clearError()
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    resetErrors()
    setSubmitting(true)
    try {
      const nextChallenge = await login(username.trim(), password, keepUnlocked)
      if (nextChallenge) {
        setChallenge(nextChallenge)
        setTotpCode('')
        setTotpMode('code')
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleTotpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challenge) return
    resetErrors()
    setSubmitting(true)
    try {
      await verifyTotp(challenge, totpMode === 'code' ? { code: totpCode } : { recoveryCode: totpCode })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '验证失败，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  function backToCredentials() {
    resetErrors()
    setChallenge(null)
    setTotpCode('')
    setPassword('')
  }

  if (challenge) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="totp-title">
          <div className="auth-brand">
            <span className="brand-mark"><span /><span /><span /></span>
            <span>CloudHub</span>
          </div>
          <p className="auth-kicker">TWO-STEP VERIFICATION</p>
          <h1 id="totp-title">输入验证码</h1>
          <p className="auth-description">
            {totpMode === 'code'
              ? '请输入验证器 App 里的 6 位验证码。'
              : '请输入保存的恢复码（格式 xxxx-xxxx）。'}
          </p>
          <form className="login-form" onSubmit={handleTotpSubmit}>
            <label>
              {totpMode === 'code' ? '验证码' : '恢复码'}
              <input
                inputMode={totpMode === 'code' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                maxLength={totpMode === 'code' ? 6 : 9}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                disabled={submitting}
                required
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="login-submit" type="submit" disabled={submitting}>
              {submitting ? '正在验证…' : '验证并登录'}
            </button>
            <div className="totp-switch">
              <button
                type="button"
                onClick={() => { setTotpMode((current) => current === 'code' ? 'recovery' : 'code'); setTotpCode(''); setError('') }}
                disabled={submitting}
              >
                {totpMode === 'code' ? '使用恢复码' : '使用验证码'}
              </button>
              <button type="button" onClick={backToCredentials} disabled={submitting}>返回</button>
            </div>
          </form>
        </section>
      </main>
    )
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
          <label className="keep-unlocked-row">
            <span className="keep-unlocked-label">
              <input type="checkbox" checked={keepUnlocked} onChange={(event) => setKeepUnlocked(event.target.checked)} disabled={submitting} />
              <span>在这台设备上保持解锁</span>
            </span>
            <span className="keep-unlocked-hint">公共电脑或别人的电脑上请不要勾选</span>
          </label>
          {(error || sessionError) && <p className="form-error" role="alert">{error || sessionError}</p>}
          <button className="login-submit" type="submit" disabled={submitting}>
            {submitting ? '正在计算密钥…' : '登录 CloudHub'}
          </button>
        </form>
        <p className="auth-note">仅限已配置的 CloudHub 账号使用</p>
      </section>
    </main>
  )
}
