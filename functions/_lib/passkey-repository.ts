export interface PasskeyCredential {
  id: string
  user_id: string
  public_key: string
  algorithm: number
  sign_count: number
  name: string
  transports: string | null
  prf_wrapped_master_key: string | null
  created_at: string
  last_used_at: string | null
}

export interface PasskeyListItem {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  transports: string | null
  prf: number
}

export interface PasskeyLoginCredential {
  id: string
  user_id: string
  public_key: string
  algorithm: number
  sign_count: number
  prf_wrapped_master_key: string | null
  username: string
  role: 'admin' | 'user'
  disabled: number
  must_change_password: number
  wrapped_master_key: string | null
}

export interface NewPasskeyCredential {
  id: string
  userId: string
  publicKey: string
  algorithm: number
  signCount: number
  name: string
  transports: string | null
  createdAt: string
}

export interface WebauthnChallenge {
  id: string
  user_id: string | null
  purpose: 'register' | 'login'
  challenge_hash: string
  ip_hash: string
  created_at: string
  expires_at: string
}

export interface NewWebauthnChallenge {
  id: string
  userId: string | null
  purpose: 'register' | 'login'
  challengeHash: string
  ipHash: string
  createdAt: string
  expiresAt: string
}

export interface PasskeyRepository {
  listPasskeys(userId: string): Promise<PasskeyListItem[]>
  countPasskeys(userId: string): Promise<number>
  findPasskeyById(id: string): Promise<PasskeyCredential | null>
  findPasskeyForLogin(credentialId: string): Promise<PasskeyLoginCredential | null>
  createPasskey(input: NewPasskeyCredential): Promise<boolean>
  updatePasskeyName(userId: string, id: string, name: string): Promise<boolean>
  setPrfWrappedKey(userId: string, id: string, prfWrappedKey: string): Promise<boolean>
  deletePasskey(userId: string, id: string): Promise<boolean>
  deletePasskeysByUser(userId: string): Promise<void>
  clearPrfWrappedKeys(userId: string): Promise<void>
  updatePasskeyUsage(id: string, signCount: number, lastUsedAt: string): Promise<void>
  createWebauthnChallenge(input: NewWebauthnChallenge): Promise<void>
  findWebauthnChallenge(challengeHash: string, now: string): Promise<WebauthnChallenge | null>
  consumeWebauthnChallenge(challengeHash: string, now: string): Promise<boolean>
}
