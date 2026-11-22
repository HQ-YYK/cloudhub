import { useState } from 'react'
import { useAuth } from '../auth/useAuth'
import CloudDrive from './CloudDrive'
import ChangePassword from './ChangePassword'
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

export default function Workspace() {
  const { user, logout } = useAuth()
  const [activeModule, setActiveModule] = useState('drive')
  const [logoutError, setLogoutError] = useState('')
  const modules: Module[] = [
    { id: 'drive', label: '私有云盘', description: '浏览目录并创建文件夹。', icon: 'drive' },
    { id: 'account', label: '账号设置', description: '修改当前用户密码。', icon: '⚙' },
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
              <span className={module.id === 'drive' ? 'sidebar-icon sidebar-drive-icon' : 'sidebar-icon'} aria-hidden="true">
                {module.id === 'drive' ? <DriveIcon /> : module.icon}
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
        {activeModule === 'account' && <ChangePassword />}
        {activeModule === 'admin' && user?.role === 'admin' && <AdminUsers />}
      </main>
    </div>
  )
}
