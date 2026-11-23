export interface StorageAccount {
  id: number
  google_email: string
  refresh_token_ciphertext: string
  refresh_token_iv: string
  root_folder_id: string
  connected_by: string
  created_at: string
  updated_at: string
}

export interface OAuthState {
  state_hash: string
  user_id: string
  expires_at: string
}

export interface StorageAdminUser {
  id: string
  role: 'admin'
  disabled: number
  must_change_password: number
}

export interface StorageRepository {
  getAccount(): Promise<StorageAccount | null>
  upsertAccount(account: StorageAccount): Promise<void>
  deleteAccount(): Promise<void>
  deleteExpiredOAuthStates(now: string): Promise<void>
  createOAuthState(stateHash: string, userId: string, expiresAt: string): Promise<void>
  consumeOAuthState(stateHash: string, now: string): Promise<OAuthState | null>
  findAdminUserById(userId: string): Promise<StorageAdminUser | null>
}
