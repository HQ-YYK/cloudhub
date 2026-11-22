import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  AdminRequestError,
  createUser,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  type AdminUser,
} from '../api/admin'

function errorMessage(error: unknown, action: 'load' | 'create' | 'reset' | 'disable') {
  if (error instanceof AdminRequestError) {
    if (error.code === 'username_taken') return '用户名已存在'
    if (error.code === 'invalid_request') return '用户名只能用 3~32 位字母、数字、`_ . -`'
    if (error.code === 'weak_password') return '密码至少 12 位'
    if (error.code === 'forbidden') return '没有权限'
  }
  return {
    load: '用户列表加载失败，请稍后重试',
    create: '新建用户失败，请稍后重试',
    reset: '重置密码失败，请稍后重试',
    disable: '修改用户状态失败，请稍后重试',
  }[action]
}

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  const loadUsers = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      setUsers(await listUsers())
    } catch (requestError) {
      setError(errorMessage(requestError, 'load'))
    } finally {
      if (refresh) setRefreshing(false)
      else setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    listUsers()
      .then((result) => {
        if (active) setUsers(result)
      })
      .catch((requestError) => {
        if (active) setError(errorMessage(requestError, 'load'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!/^[A-Za-z0-9_.-]{3,32}$/u.test(username)) {
      setError('用户名只能用 3~32 位字母、数字、`_ . -`')
      return
    }
    if (password.length < 12 || password.length > 256) {
      setError('密码至少 12 位')
      return
    }
    setCreating(true)
    try {
      await createUser(username, password)
      setUsername('')
      setPassword('')
      setSuccess('已创建，用户首次登录需修改密码')
      await loadUsers(true)
    } catch (requestError) {
      setError(errorMessage(requestError, 'create'))
    } finally {
      setCreating(false)
    }
  }

  async function handleDisabled(user: AdminUser) {
    setError('')
    setSuccess('')
    if (!user.disabled && !window.confirm('停用后，对方的登录会话会立刻失效，确定停用吗？')) return
    try {
      await setUserDisabled(user.id, user.disabled === 0)
      await loadUsers(true)
    } catch (requestError) {
      setError(errorMessage(requestError, 'disable'))
    }
  }

  async function handleReset(user: AdminUser) {
    setError('')
    setSuccess('')
    if (resetPassword.length < 12 || resetPassword.length > 256) {
      setError('密码至少 12 位')
      return
    }
    try {
      await resetUserPassword(user.id, resetPassword)
      setResetPassword('')
      setResettingId(null)
      setSuccess('已重置，对方需重新登录并修改密码')
      await loadUsers(true)
    } catch (requestError) {
      setError(errorMessage(requestError, 'reset'))
    }
  }

  return (
    <section className="admin-users">
      <div className="admin-users-toolbar">
        <div>
          <p className="workspace-kicker">USER ADMINISTRATION</p>
          <h2>用户管理</h2>
        </div>
        <button className="secondary-small-button" type="button" onClick={() => void loadUsers(true)} disabled={loading || refreshing}>
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </div>
      <form className="admin-create-form" onSubmit={handleCreate}>
        <label>用户名
          <input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} disabled={creating} />
        </label>
        <label>初始密码
          <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={creating} />
        </label>
        <button className="primary-small-button" type="submit" disabled={creating}>{creating ? '创建中…' : '新建用户'}</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="account-success" role="status">{success}</p>}
      <div className="drive-list-panel admin-table-panel">
        {loading ? (
          <p className="drive-state">正在加载用户…</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-users-table">
              <thead>
                <tr><th>用户名</th><th>角色</th><th>状态</th><th>待改密码</th><th>创建时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>{user.role === 'admin' ? '管理员' : '普通用户'}</td>
                    <td>{user.disabled === 1 ? '已停用' : '正常'}</td>
                    <td>{user.must_change_password === 1 ? '是' : '否'}</td>
                    <td>{new Date(user.created_at).toLocaleString()}</td>
                    <td>
                      {user.role === 'user' && (
                        <div className="admin-user-actions">
                          <button className="secondary-small-button" type="button" onClick={() => void handleDisabled(user)}>
                            {user.disabled === 1 ? '启用' : '停用'}
                          </button>
                          <button className="secondary-small-button" type="button" onClick={() => {
                            setResettingId(resettingId === user.id ? null : user.id)
                            setResetPassword('')
                          }}>重置密码</button>
                        </div>
                      )}
                      {resettingId === user.id && (
                        <div className="admin-reset-inline">
                          <input type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="新的临时密码" />
                          <button className="primary-small-button" type="button" onClick={() => void handleReset(user)}>确认重置</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
