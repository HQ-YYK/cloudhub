import { useState } from 'react'
import { useAuth } from '../auth/useAuth'
import CloudDrive from './CloudDrive'

type Module = {
  id: string
  label: string
  description: string
  icon: string
}

const modules: Module[] = [
  { id: 'drive', label: '私有云盘', description: '浏览目录并创建文件夹。', icon: '☁' },
]

export default function Workspace() {
  const { user, logout } = useAuth()
  const [activeModule, setActiveModule] = useState('drive')
  const [logoutError, setLogoutError] = useState('')
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
              <span className="sidebar-icon" aria-hidden="true">{module.icon}</span>
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
      </main>
    </div>
  )
}
