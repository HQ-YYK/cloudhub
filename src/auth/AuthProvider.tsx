import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AuthRequestError,
  getCurrentUser,
  getKeys,
  login as loginRequest,
  logout as logoutRequest,
  verifyTotp as verifyTotpRequest,
  type AuthUser,
  type LoginCredential,
  type TotpCredential,
} from '../api/auth.ts'
import { unwrapMasterKey } from '../crypto/index.ts'
import { clearDerivedKeys } from '../files/session.ts'
import { clearDeviceKeys, loadDeviceMk, storeDeviceKeys } from './device-keys.ts'
import { credentialFor, type AccountCredential, type AuthKeyCredential } from './credential.ts'
import { loginWithPasskey as loginWithPasskeyRequest } from './passkey.ts'
import { AuthContext, type AuthStatus } from './auth-context.ts'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [masterKey, setMasterKeyState] = useState<Uint8Array<ArrayBuffer> | null>(null)
  const [pendingCredential, setPendingCredential] = useState<AccountCredential | null>(null)
  const keepUnlockedRef = useRef(true)

  useEffect(() => {
    let active = true
    getCurrentUser()
      .then(async (currentUser) => {
        if (!active) return
        setUser(currentUser)
        setStatus(currentUser ? 'authenticated' : 'anonymous')
        if (!currentUser) {
          void clearDeviceKeys().catch(() => {})
          return
        }
        if (currentUser.keysReady && !currentUser.mustChangePassword) {
          const mk = await loadDeviceMk(currentUser.id).catch(() => null)
          if (active && mk) setMasterKeyState(mk)
        }
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

  const finishLogin = useCallback(async (authenticatedUser: AuthUser, credential: AccountCredential) => {
    if (!authenticatedUser.keysReady || authenticatedUser.mustChangePassword) {
      setPendingCredential(credential)
      setUser(authenticatedUser)
      setStatus('authenticated')
      return
    }
    const keyCredential = credential as AuthKeyCredential
    const keys = await getKeys()
    if (!keys.wrappedMasterKey) throw new AuthRequestError(500, 'invalid_response')
    const mk = await unwrapMasterKey(keys.wrappedMasterKey, keyCredential.wrapKey, authenticatedUser.id)
    setMasterKeyState(mk)
    if (keepUnlockedRef.current) {
      void storeDeviceKeys(authenticatedUser.id, mk).catch(() => {})
    } else {
      void clearDeviceKeys(authenticatedUser.id).catch(() => {})
    }
    setPendingCredential(null)
    setUser(authenticatedUser)
    setStatus('authenticated')
  }, [])

  const login = useCallback(async (username: string, password: string, keepUnlocked = true) => {
    keepUnlockedRef.current = keepUnlocked
    setError(null)
    try {
      const credential = await credentialFor(username.trim(), password)
      const loginCredential: LoginCredential = { username: username.trim(), authKey: credential.authKey }
      const result = await loginRequest(loginCredential)
      if ('totpRequired' in result) {
        setPendingCredential(credential)
        return result.challenge
      }
      await finishLogin(result.user, credential)
      return null
    } catch (requestError) {
      if (requestError instanceof Error && 'status' in requestError) {
        const status = (requestError as { status: number }).status
        if (status === 401) throw new Error('用户名或密码不正确。', { cause: requestError })
        if (status === 400) throw new Error('请输入有效的用户名和密码。', { cause: requestError })
        if (status === 0) throw new Error('网络连接失败，请稍后重试。', { cause: requestError })
      }
      throw new Error('登录服务暂时不可用，请稍后重试。', { cause: requestError })
    }
  }, [finishLogin])

  const verifyTotp = useCallback(async (challenge: string, credential: TotpCredential) => {
    setError(null)
    try {
      const authenticatedUser = await verifyTotpRequest(challenge, credential)
      const pending = pendingCredential
      if (!pending) throw new Error('登录状态已过期，请重新登录。')
      await finishLogin(authenticatedUser, pending)
    } catch (requestError) {
      if (requestError instanceof Error && requestError.message === '登录状态已过期，请重新登录。') {
        throw requestError
      }
      if (requestError instanceof Error && 'status' in requestError) {
        const status = (requestError as { status: number }).status
        if (status === 401) throw new Error('验证码不正确或已过期，多次失败请返回重新登录。', { cause: requestError })
        if (status === 400) throw new Error('请输入有效的验证码。', { cause: requestError })
        if (status === 0) throw new Error('网络连接失败，请稍后重试。', { cause: requestError })
      }
      throw new Error('登录服务暂时不可用，请稍后重试。', { cause: requestError })
    }
  }, [finishLogin, pendingCredential])

  const loginWithPasskey = useCallback(async (keepUnlocked = true) => {
    keepUnlockedRef.current = keepUnlocked
    setError(null)
    try {
      const result = await loginWithPasskeyRequest()
      const authenticatedUser = result.user
      if (!authenticatedUser.keysReady || authenticatedUser.mustChangePassword) {
        await logoutRequest().catch(() => {})
        throw new Error('此账号需要先用密码登录完成设置。')
      }
      setPendingCredential(null)
      setUser(authenticatedUser)
      setStatus('authenticated')
      if (result.mk) {
        setMasterKeyState(result.mk)
        if (keepUnlockedRef.current) {
          void storeDeviceKeys(authenticatedUser.id, result.mk).catch(() => {})
        } else {
          void clearDeviceKeys(authenticatedUser.id).catch(() => {})
        }
      } else {
        setMasterKeyState(null)
        clearDerivedKeys()
      }
    } catch (requestError) {
      if (requestError instanceof Error && 'status' in requestError) {
        const status = (requestError as { status: number }).status
        if (status === 401) throw new Error('Passkey 验证失败，请改用密码登录。', { cause: requestError })
        if (status === 0) throw new Error('网络连接失败，请稍后重试。', { cause: requestError })
      }
      throw requestError instanceof Error ? requestError : new Error('登录服务暂时不可用，请稍后重试。', { cause: requestError })
    }
  }, [])

  const logout = useCallback(async () => {
    setError(null)
    setMasterKeyState(null)
    clearDerivedKeys()
    void clearDeviceKeys().catch(() => {})
    setPendingCredential(null)
    try {
      await logoutRequest()
    } finally {
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const setMasterKey = useCallback((mk: Uint8Array<ArrayBuffer> | null) => {
    setMasterKeyState(mk)
    if (!mk) clearDerivedKeys()
  }, [])
  const completeKeySetup = useCallback((mk: Uint8Array<ArrayBuffer>) => {
    setMasterKeyState(mk)
    setPendingCredential(null)
    setUser((current) => current ? { ...current, keysReady: true, mustChangePassword: false } : current)
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const passwordChanged = useCallback(() => {
    setUser((current) => current ? { ...current, mustChangePassword: false } : current)
  }, [])
  const totpChanged = useCallback((enabled: boolean) => {
    setUser((current) => current ? { ...current, totpEnabled: enabled } : current)
  }, [])

  const value = useMemo(
    () => ({
      status,
      user,
      error,
      masterKey,
      pendingCredential,
      login,
      loginWithPasskey,
      verifyTotp,
      logout,
      setMasterKey,
      completeKeySetup,
      passwordChanged,
      totpChanged,
      clearError,
    }),
    [status, user, error, masterKey, pendingCredential, login, loginWithPasskey, verifyTotp, logout, setMasterKey, completeKeySetup, passwordChanged, totpChanged, clearError],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
