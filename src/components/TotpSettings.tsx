import { useState, type FormEvent } from 'react'
import { toDataURL } from 'qrcode'
import { AuthRequestError, disableTotp, enableTotp, setupTotp } from '../api/auth'
import { useAuth } from '../auth/useAuth'

type SetupState = {
  secret: string
  qrDataUrl: string
}

function totpError(error: unknown, action: 'setup' | 'enable' | 'disable') {
  if (error instanceof AuthRequestError) {
    if (error.code === 'invalid_code') return action === 'disable' ? '验证码或恢复码不正确' : '验证码不正确，请重试'
    if (error.code === 'invalid_credentials') return '当前密码不正确，或尝试次数过多，请稍后再试'
    if (error.code === 'totp_already_enabled') return '两步验证已开启'
    if (error.code === 'password_change_required') return '请先修改初始密码'
  }
  return {
    setup: '获取配置失败，请稍后重试',
    enable: '开启失败，请稍后重试',
    disable: '关闭失败，请稍后重试',
  }[action]
}

export default function TotpSettings() {
  const { user, totpChanged } = useAuth()
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [setupCode, setSetupCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [disableOpen, setDisableOpen] = useState(false)
  const [disablePassword, setDisablePassword] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [busy, setBusy] = useState<'setup' | 'enable' | 'disable' | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [copied, setCopied] = useState<'secret' | 'codes' | null>(null)

  async function handleStartSetup() {
    setError('')
    setSuccess('')
    setBusy('setup')
    try {
      const result = await setupTotp()
      const qrDataUrl = await toDataURL(result.otpauthUrl)
      setSetup({ secret: result.secret, qrDataUrl })
      setSetupCode('')
    } catch (requestError) {
      setError(totpError(requestError, 'setup'))
    } finally {
      setBusy(null)
    }
  }

  async function handleEnable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!/^\d{6}$/u.test(setupCode)) {
      setError('请输入 6 位数字验证码')
      return
    }
    setBusy('enable')
    try {
      const codes = await enableTotp(setupCode)
      setRecoveryCodes(codes)
      setSetup(null)
      setSetupCode('')
      totpChanged(true)
    } catch (requestError) {
      setError(totpError(requestError, 'enable'))
    } finally {
      setBusy(null)
    }
  }

  async function handleDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!disablePassword) {
      setError('请输入当前密码')
      return
    }
    if (!disableCode) {
      setError('请输入验证码或恢复码')
      return
    }
    setBusy('disable')
    try {
      await disableTotp(disablePassword, disableCode)
      totpChanged(false)
      setDisableOpen(false)
      setDisablePassword('')
      setDisableCode('')
      setSuccess('两步验证已关闭')
    } catch (requestError) {
      setError(totpError(requestError, 'disable'))
    } finally {
      setBusy(null)
    }
  }

  async function copyText(text: string, kind: 'secret' | 'codes') {
    setError('')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
    } catch {
      setError('复制失败，请手动复制')
    }
  }

  function downloadRecoveryCodes() {
    const content = recoveryCodes?.join('\n') ?? ''
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'cloudhub-recovery-codes.txt'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="drive-list-panel account-settings-panel totp-settings" aria-labelledby="totp-settings-heading">
      <div className="account-settings-heading">
        <p className="workspace-kicker">TWO-STEP VERIFICATION</p>
        <h2 id="totp-settings-heading">两步验证</h2>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="account-success" role="status">{success}</p>}

      {recoveryCodes ? (
        <div className="totp-body">
          <p className="totp-recovery-warning">每个恢复码只能用一次，请立刻保存，关闭后无法再次查看。</p>
          <ul className="recovery-codes">
            {recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
          </ul>
          <div className="recovery-actions">
            <button className="secondary-small-button" type="button" onClick={() => void copyText(recoveryCodes.join('\n'), 'codes')}>
              {copied === 'codes' ? '已复制' : '复制全部'}
            </button>
            <button className="secondary-small-button" type="button" onClick={downloadRecoveryCodes}>下载 txt</button>
            <button className="primary-small-button" type="button" onClick={() => { setRecoveryCodes(null); setCopied(null) }}>我已保存</button>
          </div>
        </div>
      ) : user?.totpEnabled ? (
        <div className="totp-body">
          <p className="totp-status is-active">已开启</p>
          <p className="totp-description">登录时需要输入验证器 App 的 6 位验证码。</p>
          {disableOpen ? (
            <form className="password-form" onSubmit={(event) => void handleDisable(event)}>
              <label>当前密码
                <input type="password" autoComplete="current-password" value={disablePassword} onChange={(event) => setDisablePassword(event.target.value)} disabled={busy !== null} />
              </label>
              <label>验证码或恢复码
                <input autoComplete="one-time-code" value={disableCode} onChange={(event) => setDisableCode(event.target.value)} disabled={busy !== null} />
              </label>
              <div className="password-actions">
                <button className="danger-small-button" type="submit" disabled={busy !== null}>{busy === 'disable' ? '关闭中…' : '确认关闭'}</button>
                <button className="secondary-small-button" type="button" onClick={() => { setDisableOpen(false); setDisablePassword(''); setDisableCode('') }} disabled={busy !== null}>取消</button>
              </div>
            </form>
          ) : (
            <button className="danger-small-button" type="button" onClick={() => { setDisableOpen(true); setError(''); setSuccess('') }}>关闭两步验证</button>
          )}
        </div>
      ) : setup ? (
        <div className="totp-body">
          <p className="totp-description">用验证器 App 扫描二维码，或手动输入密钥后，再输入 App 显示的 6 位验证码。</p>
          <img className="totp-qr" src={setup.qrDataUrl} alt="两步验证二维码" />
          <div className="totp-secret-row">
            <code className="totp-secret">{setup.secret}</code>
            <button className="secondary-small-button" type="button" onClick={() => void copyText(setup.secret, 'secret')}>
              {copied === 'secret' ? '已复制' : '复制密钥'}
            </button>
          </div>
          <form className="password-form" onSubmit={(event) => void handleEnable(event)}>
            <label>6 位验证码
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={setupCode} onChange={(event) => setSetupCode(event.target.value)} disabled={busy !== null} />
            </label>
            <div className="password-actions">
              <button className="primary-small-button" type="submit" disabled={busy !== null}>{busy === 'enable' ? '开启中…' : '确认开启'}</button>
              <button className="secondary-small-button" type="button" onClick={() => { setSetup(null); setSetupCode(''); setError('') }} disabled={busy !== null}>取消</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="totp-body">
          <p className="totp-description">开启后，登录时除了密码，还需要输入验证器 App 里的 6 位验证码。</p>
          <button className="primary-small-button" type="button" onClick={() => void handleStartSetup()} disabled={busy !== null}>
            {busy === 'setup' ? '获取中…' : '开启两步验证'}
          </button>
        </div>
      )}
    </section>
  )
}
