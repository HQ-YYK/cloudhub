import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getCurrentUser, login as loginRequest, logout as logoutRequest, type AuthUser } from '../api/auth'
import { AuthContext, type AuthStatus } from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getCurrentUser()
      .then((currentUser) => {
        if (!active) return
        setUser(currentUser)
        setStatus(currentUser ? 'authenticated' : 'anonymous')
      })
      .catch(() => {
        if (!active) return
        setError('暂时无法连接认证服务，请检查网络后重试。')
        setStatus('anonymous')
      })
    return () => {
      active = false
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setError(null)
    try {
      const authenticatedUser = await loginRequest(username, password)
      setUser(authenticatedUser)
      setStatus('authenticated')
    } catch (requestError) {
      if (requestError instanceof Error && 'status' in requestError) {
        const status = (requestError as { status: number }).status
        if (status === 401) throw new Error('用户名或密码不正确。', { cause: requestError })
        if (status === 400) throw new Error('请输入有效的用户名和密码。', { cause: requestError })
        if (status === 0) throw new Error('网络连接失败，请稍后重试。', { cause: requestError })
      }
      throw new Error('登录服务暂时不可用，请稍后重试。', { cause: requestError })
    }
  }, [])

  const logout = useCallback(async () => {
    setError(null)
    await logoutRequest()
    setUser(null)
    setStatus('anonymous')
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const passwordChanged = useCallback(() => {
    setUser((current) => current ? { ...current, mustChangePassword: false } : current)
  }, [])
  const value = useMemo(
    () => ({ status, user, error, login, logout, clearError, passwordChanged }),
    [status, user, error, login, logout, clearError, passwordChanged],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
