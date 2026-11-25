import { useState } from 'react'
import { useAuth } from '../auth/useAuth'
import CloudDrive from './CloudDrive'
import TrashBin from './TrashBin'
import MyShares from './MyShares'
import ChangePassword from './ChangePassword'
import TotpSettings from './TotpSettings'
import AdminUsers from './AdminUsers'

type Module = {
  id: string
  label: string
  description: string
  icon: string
}

function DriveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true">
      <path d="M7.25 18.25h9.5a5 5 0 0 0 .82-9.93A6.25 6.25 0 0 0 5.25 9.5a4.38 4.38 0 0 0 2 8.75Z" fill="currentColor" />
      <path d="M8.5 14.25h7M10.25 16.5h3.5" stroke="white" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true">
      <path d="M4.5 7.25h15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.25 7V5.25A1.25 1.25 0 0 1 10.5 4h3a1.25 1.25 0 0 1 1.25 1.25V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.5 7.25 7.3 19a1.75 1.75 0 0 0 1.74 1.5h5.92A1.75 1.75 0 0 0 16.7 19l.8-11.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11.25v4.5M14 11.25v4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true">
      <path d="M12 15.25V4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 8 12 4.5 15.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 13.25v4.5A1.75 1.75 0 0 0 7.75 19.5h8.5a1.75 1.75 0 0 0 1.75-1.75v-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export default function Workspace() {
  const { user, logout } = useAuth()
  const [activeModule, setActiveModule] = useState('drive')
  const [logoutError, setLogoutError] = useState('')
  const modules: Module[] = [
    { id: 'drive', label: '私有云盘', description: '浏览目录并创建文件夹。', icon: 'drive' },
    { id: 'trash', label: '回收站', description: '查看和恢复已删除的文件。', icon: 'trash' },
    { id: 'shares', label: '我的分享', description: '查看和管理已分享的文件链接。', icon: 'share' },
    { id: 'account', label: '账号设置', description: '修改密码与两步验证。', icon: '⚙' },
    ...(user?.role === 'admin'
      ? [{ id: 'admin', label: '用户管理', description: '查看和管理用户。', icon: '●' }]
      : []),
  ]
  const active = modules.find((module) => module.id === activeModule) ?? modules[0]

  async function handleLogout() {
    setLogoutError('')
    try {
      await logout()
    } catch {
      setLogoutError('退出请求未完成，服务端会话状态未知。请重试退出，或关闭此页面后重新打开。')
    }
  }

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>CloudHub</span>
        </div>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="工作台导航">
          {modules.map((module) => (
            <button
              className={activeModule === module.id ? 'sidebar-item is-active' : 'sidebar-item'}
              type="button"
              key={module.id}
              onClick={() => setActiveModule(module.id)}
            >
              <span className={module.id === 'drive' || module.id === 'trash' || module.id === 'shares' ? 'sidebar-icon sidebar-drive-icon' : 'sidebar-icon'} aria-hidden="true">
                {module.id === 'drive' ? <DriveIcon /> : module.id === 'trash' ? <TrashIcon /> : module.id === 'shares' ? <ShareIcon /> : module.icon}
              </span>
              <span>{module.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="security-badge">● 同源安全会话</span>
          <button className="logout-button" type="button" onClick={handleLogout}>退出登录</button>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="workspace-topbar">
          <div>
            <p className="workspace-kicker">CLOUDHUB WORKSPACE</p>
            <h1>{active.label}</h1>
          </div>
          <div className="user-chip">
            <span className="user-avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
            <span>{user?.username}</span>
          </div>
        </header>
        {logoutError && <p className="workspace-alert" role="alert">{logoutError}</p>}
        {activeModule === 'drive' && <CloudDrive />}
        {activeModule === 'trash' && <TrashBin />}
        {activeModule === 'shares' && <MyShares />}
        {activeModule === 'account' && (
          <div className="account-settings">
            <ChangePassword />
            <TotpSettings />
          </div>
        )}
        {activeModule === 'admin' && user?.role === 'admin' && <AdminUsers />}
      </main>
    </div>
  )
}
