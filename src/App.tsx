import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'
import LoginPage from './components/LoginPage'
import Workspace from './components/Workspace'
import './App.css'

function AppContent() {
  const { status } = useAuth()

  if (status === 'loading') {
    return <main className="app-loading" aria-live="polite"><span className="loading-mark">CH</span><p>正在恢复会话…</p></main>
  }

  return status === 'authenticated' ? <Workspace /> : <LoginPage />
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

export default App
