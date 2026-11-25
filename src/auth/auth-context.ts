import { createContext } from 'react'
import type { AuthUser, TotpCredential } from '../api/auth'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export type AuthContextValue = {
  status: AuthStatus
  user: AuthUser | null
  error: string | null
  login: (username: string, password: string) => Promise<string | null>
  verifyTotp: (challenge: string, credential: TotpCredential) => Promise<void>
  logout: () => Promise<void>
  passwordChanged: () => void
  totpChanged: (enabled: boolean) => void
  clearError: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
