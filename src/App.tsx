import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'
import { authScreen } from './auth/screen'
import LoginPage from './components/LoginPage'
import Workspace from './components/Workspace'
import SetupEncryption from './components/SetupEncryption'
import RecoveryUnlock from './components/RecoveryUnlock'
import UnlockPage from './components/UnlockPage'
import PublicShare from './components/PublicShare'
import './App.css'

function AppContent() {
  const { status, user, masterKey } = useAuth()
  const screen = authScreen(status, user, masterKey)

  if (screen === 'loading') {
    return <main className="app-loading" aria-live="polite"><span className="loading-mark">CH</span><p>正在恢复会话…</p></main>
  }
  if (screen === 'login') return <LoginPage />
  if (screen === 'setup') return <SetupEncryption mode="password" />
  if (screen === 'recovery') return <RecoveryUnlock />
  if (screen === 'unlock') return <UnlockPage />
  return <Workspace />
}

function App() {
  if (window.location.pathname.startsWith('/s/')) {
    return <PublicShare token={window.location.pathname.slice(3).split('/')[0]} />
  }
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

export default App
