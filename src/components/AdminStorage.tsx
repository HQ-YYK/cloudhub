import { useCallback, useEffect, useState } from 'react'
import {
  AdminRequestError,
  connectStorageAccount,
  listStorageAccounts,
  refreshStorageAccount,
  removeStorageAccount,
  setStorageAccountStatus,
  type StorageAccount,
} from '../api/admin'

const LOW_SPACE_BYTES = 1024 * 1024 * 1024
const NEAR_FULL_RATIO = 0.9

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatQuota(total: number | null): string {
  return total === null ? '无上限' : formatBytes(total)
}

function availableBytes(account: StorageAccount): number {
  if (account.quotaTotal === null) return Number.POSITIVE_INFINITY
  return Math.max(0, account.quotaTotal - (account.quotaUsed ?? 0))
}

function usageRatio(account: StorageAccount): number {
  if (account.quotaTotal === null || account.quotaTotal <= 0) return 0
  return (account.quotaUsed ?? 0) / account.quotaTotal
}

function statusLabel(status: StorageAccount['status']): string {
  if (status === 'active') return '使用中'
  if (status === 'readonly') return '只读'
  return '需要重新授权'
}

function errorMessage(error: unknown, action: 'load' | 'connect' | 'refresh' | 'status' | 'remove'): string {
  if (error instanceof AdminRequestError) {
    if (error.code === 'forbidden') return '没有权限'
    if (error.code === 'too_many_accounts') return '最多只能添加 10 个 Google 账号'
    if (error.code === 'account_in_use') return '这个账号上还有文件，不能移除'
    if (error.code === 'storage_reauth_required') return '授权已失效，请重新授权'
  }
  return {
    load: '存储账号加载失败，请稍后重试',
    connect: '发起授权失败，请稍后重试',
    refresh: '刷新容量失败，请稍后重试',
    status: '修改状态失败，请稍后重试',
    remove: '移除账号失败，请稍后重试',
  }[action]
}

function storageErrorNotice(code: string | null): string | null {
  if (!code) return null
  if (code === 'denied') return '授权被取消，未添加账号'
  if (code === 'too_many_accounts') return '最多只能添加 10 个 Google 账号'
  if (code === 'not_admin') return '只有管理员可以添加 Google 账号'
  if (code === 'not_configured') return '存储尚未配置'
  if (code === 'token_exchange') return 'Google 换取令牌失败，请重试'
  if (code === 'token_incomplete') return 'Google 没有返回完整的授权信息，请重试；如果反复出现，请到 Google 账号的『第三方应用』里移除 CloudHub 后再添加'
  if (code === 'drive_folder') return '在 Google 云盘里创建 CloudHub 文件夹失败，请重试'
  if (code === 'no_email' || code === 'id_token_invalid') return '无法读取 Google 账号邮箱，请重试'
  return `授权失败（代码：${code}），请重试`
}

type Banner = { kind: 'success' | 'error'; text: string }

export default function AdminStorage() {
  const [accounts, setAccounts] = useState<StorageAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [banner, setBanner] = useState<Banner | null>(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('storage')
    const errorCode = params.get('storage_error')
    if (connected === 'connected') return { kind: 'success', text: '已成功连接 Google 账号' }
    if (errorCode) return { kind: 'error', text: storageErrorNotice(errorCode) ?? '授权失败，请重试' }
    return null
  })
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setLoadError('')
    try {
      setAccounts(await listStorageAccounts())
    } catch (error) {
      setLoadError(errorMessage(error, 'load'))
    } finally {
      if (refresh) setRefreshing(false)
      else setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    listStorageAccounts()
      .then((result) => {
        if (active) setAccounts(result)
      })
      .catch((error) => {
        if (active) setLoadError(errorMessage(error, 'load'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('module') || params.has('storage') || params.has('storage_error')) {
      const url = new URL(window.location.href)
      url.searchParams.delete('module')
      url.searchParams.delete('storage')
      url.searchParams.delete('storage_error')
      window.history.replaceState(null, '', url)
    }
  }, [])

  const activeAccounts = accounts.filter((account) => account.status === 'active')
  const totalAvailable = activeAccounts.reduce((sum, account) => {
    const available = availableBytes(account)
    return Number.isFinite(available) && Number.isFinite(sum) ? sum + available : Number.POSITIVE_INFINITY
  }, 0)
  const largestAvailable = activeAccounts.reduce((largest, account) => {
    const available = availableBytes(account)
    return available > largest ? available : largest
  }, 0)
  const lowSpace = activeAccounts.length > 0 && Number.isFinite(totalAvailable) && totalAvailable < LOW_SPACE_BYTES

  async function handleConnect() {
    setLoadError('')
    setBanner(null)
    if (!window.confirm('会跳转到 Google 授权页。请用要添加的那个 Google 账号登录。CloudHub 只能访问它自己创建的文件。')) return
    try {
      const url = await connectStorageAccount()
      window.location.href = url
    } catch (error) {
      setLoadError(errorMessage(error, 'connect'))
    }
  }

  async function handleRefresh(account: StorageAccount) {
    setLoadError('')
    setBanner(null)
    setBusyId(account.id)
    try {
      await refreshStorageAccount(account.id)
      await load(true)
    } catch (error) {
      setLoadError(errorMessage(error, 'refresh'))
    } finally {
      setBusyId(null)
    }
  }

  async function handleStatus(account: StorageAccount) {
    setLoadError('')
    setBanner(null)
    const next = account.status === 'readonly' ? 'active' : 'readonly'
    if (next === 'readonly' && !window.confirm('只读后不会再往这个账号上传新文件，已有文件照常可以下载和删除。')) return
    setBusyId(account.id)
    try {
      await setStorageAccountStatus(account.id, next)
      await load(true)
    } catch (error) {
      setLoadError(errorMessage(error, 'status'))
    } finally {
      setBusyId(null)
    }
  }

  async function handleReauth() {
    setLoadError('')
    setBanner(null)
    try {
      const url = await connectStorageAccount()
      window.location.href = url
    } catch (error) {
      setLoadError(errorMessage(error, 'connect'))
    }
  }

  async function handleRemove(account: StorageAccount) {
    setLoadError('')
    setBanner(null)
    if (!window.confirm('只移除 CloudHub 里的记录，不会删除 Google 云盘里的任何内容。')) return
    setBusyId(account.id)
    try {
      await removeStorageAccount(account.id)
      await load(true)
    } catch (error) {
      setLoadError(errorMessage(error, 'remove'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="admin-storage">
      <div className="admin-users-toolbar">
        <div>
          <p className="workspace-kicker">STORAGE ADMINISTRATION</p>
          <h2>存储</h2>
        </div>
        <div className="admin-storage-toolbar-actions">
          <button className="secondary-small-button" type="button" onClick={() => void load(true)} disabled={loading || refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <button className="primary-small-button" type="button" onClick={() => void handleConnect()}>添加 Google 账号</button>
        </div>
      </div>

      <p className="admin-storage-note">免费计划每天 10 万次请求，北京时间早上 8 点重置，超出后所有用户都会暂时无法使用。大文件上传每 32 MiB 计一次请求，10 GiB 文件约 320 次请求。</p>

      {lowSpace && <p className="admin-storage-alert is-danger" role="alert">存储空间不足，请添加 Google 账号或清理回收站</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {banner && (
        <p className={banner.kind === 'success' ? 'admin-storage-alert is-success' : 'admin-storage-alert is-danger'} role="status">{banner.text}</p>
      )}

      <div className="admin-storage-summary">
        <div className="admin-storage-stat">
          <span className="admin-storage-stat-label">总可用空间</span>
          <span className="admin-storage-stat-value">{Number.isFinite(totalAvailable) ? formatBytes(totalAvailable) : '无上限'}</span>
        </div>
        <div className="admin-storage-stat">
          <span className="admin-storage-stat-label">单个文件最大能传</span>
          <span className="admin-storage-stat-value">{Number.isFinite(largestAvailable) ? formatBytes(largestAvailable) : '无上限'}</span>
        </div>
      </div>

      <div className="drive-list-panel admin-table-panel">
        {loading ? (
          <p className="drive-state">正在加载存储账号…</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-users-table admin-storage-table">
              <thead>
                <tr><th>Google 账号</th><th>状态</th><th>已用 / 总量</th><th>文件数</th><th>占用</th><th>最近检查</th><th>操作</th></tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      {account.googleEmail}
                      {account.status === 'reauth' && <p className="admin-storage-row-warning is-danger">授权已失效，这个账号上的文件暂时无法下载，请重新授权</p>}
                    </td>
                    <td><span className={`admin-storage-status is-${account.status}`}>{statusLabel(account.status)}</span></td>
                    <td>
                      <div className="admin-storage-quota">
                        <span>{formatBytes(account.quotaUsed ?? 0)} / {formatQuota(account.quotaTotal)}</span>
                        <span className="admin-storage-progress"><span style={{ width: `${Math.min(100, usageRatio(account) * 100)}%` }} /></span>
                        {account.quotaTotal !== null && usageRatio(account) >= NEAR_FULL_RATIO && <span className="admin-storage-row-warning">空间快满了</span>}
                      </div>
                    </td>
                    <td>{account.fileCount}</td>
                    <td>{formatBytes(account.bytesStored)}</td>
                    <td>{account.quotaCheckedAt ? new Date(account.quotaCheckedAt).toLocaleString() : '从未检查'}</td>
                    <td>
                      <div className="admin-user-actions">
                        <button className="secondary-small-button" type="button" onClick={() => void handleRefresh(account)} disabled={busyId === account.id}>刷新容量</button>
                        <button className="secondary-small-button" type="button" onClick={() => void handleStatus(account)} disabled={busyId === account.id}>
                          {account.status === 'readonly' ? '恢复使用' : '设为只读'}
                        </button>
                        {account.status === 'reauth' && (
                          <button className="secondary-small-button" type="button" onClick={() => void handleReauth()} disabled={busyId === account.id}>重新授权</button>
                        )}
                        <button
                          className="secondary-small-button"
                          type="button"
                          onClick={() => void handleRemove(account)}
                          disabled={busyId === account.id || account.fileCount > 0}
                          title={account.fileCount > 0 ? `这个账号上还有 ${account.fileCount} 个文件，不能移除` : undefined}
                        >移除</button>
                      </div>
                      {account.fileCount > 0 && <p className="admin-storage-row-warning">这个账号上还有 {account.fileCount} 个文件，不能移除</p>}
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
