import { useState, type FormEvent } from 'react'
import { toDataURL } from 'qrcode'
import { AuthRequestError, disableTotp, enableTotp, setupTotp } from '../api/auth'
import { useAuth } from '../auth/useAuth'
import { credentialFor } from '../auth/credential'

type SetupState = {
  secret: string
  qrDataUrl: string
  otpauthUrl: string
}

type TotpParamKey = 'issuer' | 'account' | 'secret' | 'type' | 'algorithm' | 'digits' | 'period'
type CopiedKind = TotpParamKey | 'codes'

function groupSecret(secret: string) {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

function totpParamRows(secret: string, username: string): Array<{ key: TotpParamKey, label: string, value: string, display: string }> {
  return [
    { key: 'issuer', label: '发行方', value: 'CloudHub', display: 'CloudHub' },
    { key: 'account', label: '账号', value: username, display: username },
    { key: 'secret', label: '密钥', value: secret, display: groupSecret(secret) },
    { key: 'type', label: '类型', value: '基于时间（TOTP）', display: '基于时间（TOTP）' },
    { key: 'algorithm', label: '算法', value: 'SHA1', display: 'SHA1' },
    { key: 'digits', label: '位数', value: '6', display: '6' },
    { key: 'period', label: '时间间隔', value: '30 秒', display: '30 秒' },
  ]
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
  const [copied, setCopied] = useState<CopiedKind | null>(null)

  async function handleStartSetup() {
    setError('')
    setSuccess('')
    setCopied(null)
    setBusy('setup')
    try {
      const result = await setupTotp()
      const qrDataUrl = await toDataURL(result.otpauthUrl)
      setSetup({ secret: result.secret, qrDataUrl, otpauthUrl: result.otpauthUrl })
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
      const credential = await credentialFor(user?.username ?? '', disablePassword)
      const totpCredential = 'password' in credential
        ? { password: credential.password }
        : { authKey: credential.authKey }
      await disableTotp(totpCredential, disableCode)
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

  async function copyText(text: string, kind: CopiedKind) {
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
                <button className="danger-small-button" type="submit" disabled={busy !== null}>{busy === 'disable' ? '正在计算密钥…' : '确认关闭'}</button>
                <button className="secondary-small-button" type="button" onClick={() => { setDisableOpen(false); setDisablePassword(''); setDisableCode('') }} disabled={busy !== null}>取消</button>
              </div>
            </form>
          ) : (
            <button className="danger-small-button" type="button" onClick={() => { setDisableOpen(true); setError(''); setSuccess('') }}>关闭两步验证</button>
          )}
        </div>
      ) : setup ? (
        <div className="totp-body">
          <p className="totp-description">用验证器 App 扫描二维码；在手机上可点击下方按钮直接添加，或按下表手动输入。然后输入 App 显示的 6 位验证码。</p>
          <img className="totp-qr" src={setup.qrDataUrl} alt="两步验证二维码" />
          <div className="totp-open-row">
            <a className="primary-small-button totp-open-link" href={setup.otpauthUrl}>在验证器 App 中打开</a>
            <span className="totp-open-hint">手机上无法扫描本机二维码时，点这里直接添加</span>
          </div>
          <table className="totp-params">
            <tbody>
              {totpParamRows(setup.secret, user?.username ?? '').map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td><code className="totp-param-value">{row.display}</code></td>
                  <td className="totp-param-copy">
                    <button className="secondary-small-button" type="button" onClick={() => void copyText(row.value, row.key)}>
                      {copied === row.key ? '已复制' : '复制'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="password-form" onSubmit={(event) => void handleEnable(event)}>
            <label>6 位验证码
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={setupCode} onChange={(event) => setSetupCode(event.target.value)} disabled={busy !== null} />
            </label>
            <div className="password-actions">
              <button className="primary-small-button" type="submit" disabled={busy !== null}>{busy === 'enable' ? '开启中…' : '确认开启'}</button>
              <button className="secondary-small-button" type="button" onClick={() => { setSetup(null); setSetupCode(''); setError(''); setCopied(null) }} disabled={busy !== null}>取消</button>
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
