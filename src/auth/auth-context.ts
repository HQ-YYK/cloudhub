import { createContext } from 'react'
import type { AuthUser, TotpCredential } from '../api/auth.ts'
import type { AccountCredential } from './credential.ts'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export type AuthContextValue = {
  status: AuthStatus
  user: AuthUser | null
  error: string | null
  masterKey: Uint8Array<ArrayBuffer> | null
  pendingCredential: AccountCredential | null
  login: (username: string, password: string, keepUnlocked?: boolean) => Promise<string | null>
  verifyTotp: (challenge: string, credential: TotpCredential) => Promise<void>
  logout: () => Promise<void>
  setMasterKey: (masterKey: Uint8Array<ArrayBuffer> | null) => void
  completeKeySetup: (masterKey: Uint8Array<ArrayBuffer>) => void
  passwordChanged: () => void
  totpChanged: (enabled: boolean) => void
  clearError: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
