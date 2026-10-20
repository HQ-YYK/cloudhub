import { useState } from 'react'
import { useAuth } from '../auth/useAuth'

type Module = {
  id: string
  label: string
  description: string
  icon: string
  available: boolean
}

const modules: Module[] = [
  { id: 'overview', label: '工作台概览', description: '查看 CloudHub 的当前状态和工作方向。', icon: '⌂', available: true },
  { id: 'drive', label: '私有云盘', description: '私密文件管理、上传与共享能力。', icon: '☁', available: false },
  { id: 'gpu', label: 'GPU 训练', description: '训练任务、日志和实验结果。', icon: '▣', available: false },
  { id: 'deploy', label: '项目部署', description: '项目地址、部署状态和文档。', icon: '↗', available: false },
  { id: 'blog', label: '技术博客', description: '技术学习、开发过程和实验总结。', icon: '▤', available: false },
]

const projects = [
  { name: 'Rehab-RAG', description: '基于检索增强生成的康复辅助系统。', tags: ['RAG', 'AI 应用'], status: '持续探索' },
  { name: 'MediaPipe Motion Analysis', description: '人体姿态与动作分析方向的实验项目。', tags: ['Computer Vision', 'MediaPipe'], status: '实验中' },
  { name: 'CloudHub', description: '个人云端工作台，连接想法、项目与长期积累。', tags: ['React', 'TypeScript'], status: '当前工作台' },
]

export default function Workspace() {
  const { user, logout } = useAuth()
  const [activeModule, setActiveModule] = useState('overview')
  const [logoutError, setLogoutError] = useState('')
  const active = modules.find((module) => module.id === activeModule) ?? modules[0]

  async function handleLogout() {
    setLogoutError('')
    try {
      await logout()
    } catch {
      setLogoutError('退出请求未完成，但本地登录状态已清理。请稍后重新登录。')
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
              {!module.available && <small>规划中</small>}
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
        {!active.available ? (
          <section className="empty-module" aria-live="polite">
            <span className="empty-module-icon">{active.icon}</span>
            <p className="workspace-kicker">COMING SOON</p>
            <h2>{active.label}正在建设中</h2>
            <p>{active.description}当前仅展示模块入口，不会伪造真实数据或操作结果。</p>
            <button className="outline-button" type="button" onClick={() => setActiveModule('overview')}>返回工作台概览</button>
          </section>
        ) : (
          <Overview />
        )}
      </main>
    </div>
  )
}

function Overview() {
  return (
    <div className="overview-content">
      <section className="welcome-panel">
        <div>
          <p className="workspace-kicker">KEEP BUILDING</p>
          <h2>把每一个想法，<br /><em>变成长期积累。</em></h2>
          <p>CloudHub 将逐步连接你的文件、实验、项目与思考。</p>
        </div>
        <div className="welcome-orbit" aria-hidden="true"><span>CH</span></div>
      </section>
      <section className="overview-section">
        <div className="content-heading"><div><p className="workspace-kicker">MODULES</p><h2>工作模块</h2></div><span>按需扩展，保持专注</span></div>
        <div className="module-grid">
          {modules.slice(1).map((module) => (
            <div className="module-card" key={module.id}>
              <span className="module-card-icon">{module.icon}</span>
              <h3>{module.label}</h3>
              <p>{module.description}</p>
              <span className="planned-tag">规划中</span>
            </div>
          ))}
        </div>
      </section>
      <section className="overview-section">
        <div className="content-heading"><div><p className="workspace-kicker">PROJECTS</p><h2>我的项目</h2></div><span>本地静态展示</span></div>
        <div className="dashboard-projects">
          {projects.map((project) => (
            <article className="dashboard-project" key={project.name}>
              <div className="project-title"><span className="project-status-dot" /><h3>{project.name}</h3></div>
              <p>{project.description}</p>
              <div className="project-meta"><span>{project.tags.join(' · ')}</span><strong>{project.status}</strong></div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
