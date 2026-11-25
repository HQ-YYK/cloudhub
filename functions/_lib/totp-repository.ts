export interface TotpUser {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: number
  must_change_password: number
  totp_secret_ciphertext: string | null
  totp_secret_iv: string | null
  totp_pending_ciphertext: string | null
  totp_pending_iv: string | null
  totp_enabled_at: string | null
  totp_last_step: number | null
}

export interface RecoveryCodeRecord {
  id: string
  user_id: string
  code_hash: string
  created_at: string
  used_at: string | null
}

export interface LoginChallengeRecord {
  id: string
  user_id: string
  token_hash: string
  ip_hash: string
  created_at: string
  expires_at: string
  failed_count: number
}

export interface NewLoginChallenge {
  id: string
  userId: string
  tokenHash: string
  ipHash: string
  createdAt: string
  expiresAt: string
}

export interface NewRecoveryCode {
  id: string
  userId: string
  codeHash: string
  createdAt: string
}

export interface TotpRepository {
  findTotpUser(userId: string): Promise<TotpUser | null>
  setPendingSecret(userId: string, ciphertext: string, iv: string, updatedAt: string): Promise<void>
  enableTotp(userId: string, ciphertext: string, iv: string, enabledAt: string): Promise<void>
  disableTotp(userId: string, updatedAt: string): Promise<void>
  updateLastStep(userId: string, lastStep: number): Promise<boolean>
  createRecoveryCodes(codes: NewRecoveryCode[]): Promise<void>
  deleteRecoveryCodes(userId: string): Promise<void>
  findRecoveryCode(userId: string, codeHash: string): Promise<RecoveryCodeRecord | null>
  markRecoveryCodeUsed(id: string, usedAt: string): Promise<boolean>
  createLoginChallenge(input: NewLoginChallenge): Promise<void>
  findLoginChallengeByTokenHash(tokenHash: string, now: string): Promise<LoginChallengeRecord | null>
  incrementLoginChallengeFailure(tokenHash: string): Promise<void>
  deleteLoginChallengeByTokenHash(tokenHash: string): Promise<boolean>
}
