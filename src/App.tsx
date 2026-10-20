import { useState, type ReactNode } from 'react'
import './App.css'

type IconName = 'cloud' | 'cpu' | 'rocket' | 'book' | 'arrow' | 'menu' | 'close'

type Feature = {
  icon: IconName
  eyebrow: string
  title: string
  description: string
  accent: string
}

type Project = {
  name: string
  description: string
  tags: string[]
  status: string
  statusTone: 'progress' | 'planning'
  accent: string
}

const navItems = [
  { label: '工作台', href: '#home' },
  { label: '云盘', href: '#features' },
  { label: 'GPU 实验室', href: '#features' },
  { label: '项目中心', href: '#projects' },
  { label: '技术博客', href: '#features' },
]

const features: Feature[] = [
  {
    icon: 'cloud',
    eyebrow: 'CLOUD DRIVE',
    title: 'CloudDrive 云盘',
    description: '私人文件管理、文件上传下载与共享文件夹。',
    accent: 'blue',
  },
  {
    icon: 'cpu',
    eyebrow: 'CLOUD GPU',
    title: 'CloudGPU 训练实验室',
    description: '管理机器学习训练任务、训练日志和实验结果。',
    accent: 'purple',
  },
  {
    icon: 'rocket',
    eyebrow: 'DEPLOY HUB',
    title: 'DeployHub 项目部署中心',
    description: '集中展示个人开发项目、部署地址与项目文档。',
    accent: 'orange',
  },
  {
    icon: 'book',
    eyebrow: 'DEVBLOG',
    title: 'DevBlog 技术博客',
    description: '记录技术学习、项目开发过程和实验总结。',
    accent: 'green',
  },
]

const projects: Project[] = [
  {
    name: 'Rehab-RAG',
    description: '基于检索增强生成的康复辅助系统。',
    tags: ['RAG', 'AI 应用'],
    status: '持续探索',
    statusTone: 'progress',
    accent: 'coral',
  },
  {
    name: 'MediaPipe Motion Analysis',
    description: '人体姿态与动作分析方向的实验项目。',
    tags: ['Computer Vision', 'MediaPipe'],
    status: '实验中',
    statusTone: 'progress',
    accent: 'blue',
  },
  {
    name: 'CloudHub',
    description: '个人云端工作台，连接想法、项目与长期积累。',
    tags: ['React', 'TypeScript'],
    status: '规划中',
    statusTone: 'planning',
    accent: 'purple',
  },
]

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    cloud: (
      <>
        <path d="M17.5 19H9a6 6 0 1 1 5.7-7.85A4.5 4.5 0 1 1 17.5 19Z" />
        <path d="M12 15.5v-5m0 0-2 2m2-2 2 2" />
      </>
    ),
    cpu: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <path d="M9 9h6v6H9zM9 2v4m6-4v4m0 12v4m-6-4v4m9-13h4m-4 6h4M2 9h4m-4 6h4" />
      </>
    ),
    rocket: (
      <>
        <path d="M14.5 5.5C17 3 20 3 21 3c0 1 0 4-2.5 6.5l-6 6-4-4 6-6Z" />
        <path d="m8.5 11.5-3 1-2 4 4-2 1-3Zm3 3-1 3-4 2 2-4 3-1ZM14 10l-2-2" />
        <circle cx="16.5" cy="7.5" r="1" />
      </>
    ),
    book: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" />
        <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20M8 7h8m-8 4h5" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  }

  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState('')

  const showNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2800)
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#home" aria-label="CloudHub 首页">
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          <span>CloudHub</span>
        </a>
        <button
          className="menu-toggle"
          type="button"
          aria-label={menuOpen ? '关闭导航菜单' : '打开导航菜单'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} />
        </button>
        <nav className={menuOpen ? 'main-nav is-open' : 'main-nav'} aria-label="主导航">
          {navItems.map((item) => (
            <a key={item.label} href={item.href} onClick={() => setMenuOpen(false)}>
              {item.label}
            </a>
          ))}
        </nav>
        <a className="button button-primary header-cta" href="#home">
          进入工作台 <Icon name="arrow" />
        </a>
      </header>

      <main>
        <section className="hero section-wrap" id="home">
          <div className="hero-copy">
            <p className="kicker"><span /> PERSONAL CLOUD WORKSPACE</p>
            <h1>你的个人<br /><em>云端工作台</em></h1>
            <p className="hero-description">
              统一管理文件、机器学习实验与开发项目，让每一个想法都能持续积累。
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#features">探索功能 <Icon name="arrow" /></a>
              <a className="button button-secondary" href="#projects">查看我的项目 <Icon name="arrow" /></a>
            </div>
            <p className="hero-note"><span className="status-dot" /> 专注构建，持续积累</p>
          </div>
          <div className="workspace-preview" aria-label="CloudHub 工作台示意图">
            <div className="preview-orbit orbit-one" />
            <div className="preview-orbit orbit-two" />
            <div className="preview-card preview-main">
              <div className="preview-card-top"><span className="mini-brand">C</span><span>WORKSPACE</span><span className="preview-dots">•••</span></div>
              <div className="preview-welcome">你好，开始今天的创造吧 <span>✦</span></div>
              <div className="preview-grid">
                <div><strong>04</strong><span>工作模块</span></div>
                <div><strong>∞</strong><span>持续积累</span></div>
              </div>
              <div className="preview-line"><span /><span /><span /></div>
            </div>
            <div className="floating-chip chip-file"><span className="chip-icon blue-bg"><Icon name="cloud" /></span><span><b>文件空间</b><small>随时访问</small></span><i>↗</i></div>
            <div className="floating-chip chip-lab"><span className="chip-icon purple-bg"><Icon name="cpu" /></span><span><b>实验记录</b><small>持续探索</small></span></div>
          </div>
        </section>

        <section className="section-wrap features-section" id="features">
          <div className="section-heading">
            <div><p className="kicker">WHAT&apos;S INSIDE</p><h2>为长期积累而设计</h2></div>
            <p>从文件到实验，从项目到思考，<br />把分散的工作汇聚到一个地方。</p>
          </div>
          <div className="feature-grid">
            {features.map((feature) => (
              <article className={`feature-card accent-${feature.accent}`} key={feature.title}>
                <div className="feature-icon"><Icon name={feature.icon} /></div>
                <p className="card-eyebrow">{feature.eyebrow}</p>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
                <button type="button" onClick={() => showNotice(`${feature.title}正在开发中，敬请期待。`)}>了解更多 <Icon name="arrow" /></button>
              </article>
            ))}
          </div>
        </section>

        <section className="projects-section" id="projects">
          <div className="section-wrap">
            <div className="section-heading projects-heading">
              <div><p className="kicker">SELECTED WORK</p><h2>我的项目</h2></div>
              <p>一些正在进行或持续思考中的方向。<br />项目会随着实践不断生长。</p>
            </div>
            <div className="project-list">
              {projects.map((project, index) => (
                <article className="project-row" key={project.name}>
                  <span className={`project-number number-${project.accent}`}>0{index + 1}</span>
                  <div className="project-info"><h3>{project.name}</h3><p>{project.description}</p></div>
                  <div className="project-tags">{project.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                  <span className={`project-status ${project.statusTone}`}><i />{project.status}</span>
                  <button type="button" className="project-arrow" aria-label={`查看 ${project.name}`} onClick={() => showNotice(`${project.name}详情将在项目中心开放。`)}><Icon name="arrow" /></button>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="about-section section-wrap" id="about">
          <div className="about-avatar" aria-hidden="true"><span>?</span></div>
          <div className="about-copy"><p className="kicker">A LITTLE ABOUT ME</p><h2>关于我</h2><p>我正在探索 AI 应用开发、RAG、Agent、计算机视觉与云端部署。CloudHub 是一个记录学习、实验与构建过程的个人空间。</p><p className="placeholder">个人信息将在准备好后补充。</p></div>
          <div className="about-focus"><span>FOCUS AREAS</span><strong>AI 应用开发</strong><strong>RAG &amp; Agent</strong><strong>Computer Vision</strong><strong>Cloud Deployment</strong></div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="section-wrap footer-inner">
          <a className="brand" href="#home"><span className="brand-mark"><span /><span /><span /></span><span>CloudHub</span></a>
          <p>让每一个想法，都有一个持续生长的地方。</p>
          <span className="footer-github">GitHub 链接待补充</span>
          <small>© 2026 CloudHub. Built for ideas.</small>
        </div>
      </footer>
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  )
}

export default App
