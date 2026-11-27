import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AuthRequestError } from '../api/auth'
import { deletePasskey, listPasskeys, renamePasskey, type Passkey } from '../api/passkeys'
import { isPasskeySupported, registerPasskey } from '../auth/passkey'
import { useAuth } from '../auth/useAuth'

function formatTime(value: string | null): string {
  if (!value) return '从未使用'
  return new Date(value).toLocaleString()
}

function passkeyError(error: unknown, fallback: string): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'passkey_limit') return 'Passkey 数量已达上限（10 个）。'
    if (error.code === 'keys_not_ready') return '账号还没有设置文件加密。'
    if (error.code === 'password_change_required') return '请先修改初始密码。'
    if (error.code === 'passkey_exists') return '这个认证器已经添加过了。'
    if (error.code === 'unsupported_algorithm') return '此认证器不支持需要的签名算法。'
    if (error.code === 'invalid_passkey') return '认证器校验失败，请重试。'
    if (error.code === 'prf_already_set') return '该 Passkey 已保存过解锁密钥。'
    if (error.status === 404) return '这个 Passkey 已不存在。'
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export default function PasskeySettings() {
  const { user, masterKey } = useAuth()
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const reload = useCallback(async () => {
    try {
      setPasskeys(await listPasskeys())
      setLoaded(true)
    } catch {
      setError('加载 Passkey 列表失败，请稍后重试。')
    }
  }, [])

  useEffect(() => {
    let active = true
    listPasskeys()
      .then((items) => {
        if (!active) return
        setPasskeys(items)
        setLoaded(true)
      })
      .catch(() => {
        if (!active) return
        setError('加载 Passkey 列表失败，请稍后重试。')
      })
    return () => {
      active = false
    }
  }, [])

  if (!user) return null
  if (!isPasskeySupported()) {
    return (
      <section className="drive-list-panel account-settings-panel passkey-settings" aria-labelledby="passkey-settings-heading">
        <div className="account-settings-heading">
          <p className="workspace-kicker">PASSKEYS</p>
          <h2 id="passkey-settings-heading">Passkey</h2>
        </div>
        <p className="totp-description">当前浏览器不支持 Passkey。</p>
      </section>
    )
  }

  const knownCount = passkeys.length > 0 ? passkeys.length : (user.passkeyCount ?? 0)
  const atLimit = knownCount >= 10

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!user || !masterKey) return
    setBusy(true)
    try {
      const result = await registerPasskey(masterKey, name, user.id)
      setName('')
      await reload()
      if (result.prf) {
        setSuccess('Passkey 已添加。')
      } else {
        setSuccess('这个 Passkey 不支持免密码解锁，用它登录后还要输入密码才能打开文件。')
      }
    } catch (requestError) {
      setError(passkeyError(requestError, '添加 Passkey 失败，请稍后重试。'))
    } finally {
      setBusy(false)
    }
  }

  function startRename(passkey: Passkey) {
    setEditingId(passkey.id)
    setEditingName(passkey.name)
    setError('')
    setSuccess('')
  }

  function cancelRename() {
    setEditingId(null)
    setEditingName('')
  }

  async function saveRename(id: string) {
    const trimmed = editingName.trim()
    if (!trimmed || trimmed.length > 64) {
      setError('名称需为 1–64 个字符。')
      return
    }
    const current = passkeys.find((passkey) => passkey.id === id)
    if (current && trimmed === current.name) {
      cancelRename()
      return
    }
    setError('')
    setSuccess('')
    setSavingId(id)
    try {
      await renamePasskey(id, trimmed)
      await reload()
      cancelRename()
      setSuccess('已改名。')
    } catch (requestError) {
      setError(passkeyError(requestError, '改名失败，请稍后重试。'))
    } finally {
      setSavingId(null)
    }
  }

  async function handleDelete(passkey: Passkey) {
    if (!window.confirm(`确定删除 Passkey「${passkey.name}」吗？`)) return
    setError('')
    setSuccess('')
    setDeletingId(passkey.id)
    try {
      await deletePasskey(passkey.id)
      await reload()
      setSuccess('已删除。')
    } catch (requestError) {
      setError(passkeyError(requestError, '删除失败，请稍后重试。'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="drive-list-panel account-settings-panel passkey-settings" aria-labelledby="passkey-settings-heading">
      <div className="account-settings-heading">
        <p className="workspace-kicker">PASSKEYS</p>
        <h2 id="passkey-settings-heading">Passkey</h2>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="account-success" role="status">{success}</p>}

      <form className="password-form" onSubmit={(event) => void handleAdd(event)}>
        <label>名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="留空则为「Passkey」"
            maxLength={64}
            disabled={busy}
          />
        </label>
        <div className="password-actions">
          <button className="primary-small-button" type="submit" disabled={busy || !masterKey || atLimit}>
            {busy ? '添加中…' : '添加 Passkey'}
          </button>
        </div>
      </form>
      {!masterKey && <p className="totp-description">请先输入密码解锁文件后再添加 Passkey。</p>}
      {atLimit && <p className="totp-description">Passkey 数量已达上限（10 个），删除一个后才能再添加。</p>}

      {loaded && passkeys.length === 0 ? (
        <p className="totp-description">还没有添加过 Passkey。</p>
      ) : (
        <ul className="passkey-list">
          {passkeys.map((passkey) => (
            <li className="passkey-row" key={passkey.id}>
              <div className="passkey-row-main">
                <div className="passkey-row-title">
                  {editingId === passkey.id ? (
                    <input
                      className="passkey-rename-input"
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void saveRename(passkey.id)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRename()
                        }
                      }}
                      maxLength={64}
                      autoFocus
                    />
                  ) : (
                    <span className="passkey-name">{passkey.name}</span>
                  )}
                  <span className={passkey.prf ? 'passkey-tag is-unlock' : 'passkey-tag'}>
                    {passkey.prf ? '可免密码解锁' : '仅登录'}
                  </span>
                </div>
                <p className="passkey-meta">添加于 {formatTime(passkey.createdAt)} · 最近使用 {formatTime(passkey.lastUsedAt)}</p>
              </div>
              <div className="passkey-row-actions">
                {editingId === passkey.id ? (
                  <>
                    <button className="secondary-small-button" type="button" onClick={() => void saveRename(passkey.id)} disabled={savingId === passkey.id}>
                      保存
                    </button>
                    <button className="secondary-small-button" type="button" onClick={cancelRename} disabled={savingId === passkey.id}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button className="secondary-small-button" type="button" onClick={() => startRename(passkey)} disabled={deletingId !== null}>
                      改名
                    </button>
                    <button className="danger-small-button" type="button" onClick={() => void handleDelete(passkey)} disabled={deletingId !== null}>
                      {deletingId === passkey.id ? '删除中…' : '删除'}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="passkey-notes">
        <p>删除 Passkey 不影响密码登录。忘记密码时仍需恢复码找回文件，请继续妥善保管恢复码。</p>
        <p>管理员重置你的密码后，所有 Passkey 会被删除，需要重新添加。</p>
        {passkeys.some((passkey) => !passkey.prf) && (
          <p>重置加密密钥后，旧 Passkey 只能用于登录，删除后重新添加即可恢复免密码解锁。</p>
        )}
      </div>
    </section>
  )
}
