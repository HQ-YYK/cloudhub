import type { AuthUser } from '../api/auth.ts'

export type AuthScreen =
  | 'loading'
  | 'login'
  | 'setup'
  | 'recovery'
  | 'unlock'
  | 'workspace'

export function authScreen(
  status: 'loading' | 'authenticated' | 'anonymous',
  user: AuthUser | null,
  masterKey: Uint8Array | null,
): AuthScreen {
  if (status === 'loading') return 'loading'
  if (status === 'anonymous' || !user) return 'login'
  if (user.legacy || !user.keysReady) return 'setup'
  if (user.mustChangePassword) return 'recovery'
  if (!masterKey) return 'unlock'
  return 'workspace'
}
