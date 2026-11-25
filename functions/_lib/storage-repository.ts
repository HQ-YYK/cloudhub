export type StorageAccountStatus = 'active' | 'readonly' | 'reauth'

export const MAX_STORAGE_ACCOUNTS = 10

export interface StorageAccount {
  id: number
  google_email: string
  refresh_token_ciphertext: string
  refresh_token_iv: string
  root_folder_id: string
  connected_by: string
  status: StorageAccountStatus
  quota_total: number | null
  quota_used: number | null
  quota_checked_at: string | null
  created_at: string
  updated_at: string
}

export interface StorageAccountWithStats extends StorageAccount {
  file_count: number
  bytes_stored: number
}

export interface NewStorageAccount {
  googleEmail: string
  refreshTokenCiphertext: string
  refreshTokenIv: string
  rootFolderId: string
  connectedBy: string
  createdAt: string
  updatedAt: string
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
  getAccount(accountId: number): Promise<StorageAccount | null>
  listAccounts(): Promise<StorageAccount[]>
  listAccountsWithStats(): Promise<StorageAccountWithStats[]>
  countAccounts(): Promise<number>
  findAccountByEmail(email: string): Promise<StorageAccount | null>
  createAccount(input: NewStorageAccount): Promise<StorageAccount>
  updateAccountTokens(
    accountId: number,
    googleEmail: string,
    refreshTokenCiphertext: string,
    refreshTokenIv: string,
    connectedBy: string,
    status: StorageAccountStatus,
    updatedAt: string,
  ): Promise<StorageAccount | null>
  setAccountStatus(accountId: number, status: StorageAccountStatus, updatedAt: string): Promise<StorageAccount | null>
  setAccountReauth(accountId: number, updatedAt: string): Promise<void>
  setAccountQuota(accountId: number, quotaTotal: number | null, quotaUsed: number | null, checkedAt: string): Promise<void>
  deleteAccount(accountId: number): Promise<void>
  countFilesByAccount(accountId: number): Promise<number>
  pendingBytesByAccount(accountId: number): Promise<number>

  findUserFolder(accountId: number, userId: string): Promise<{ user_id: string; folder_id: string } | null>
  setUserFolderIfEmpty(accountId: number, userId: string, folderId: string): Promise<boolean>

  deleteExpiredOAuthStates(now: string): Promise<void>
  createOAuthState(stateHash: string, userId: string, expiresAt: string): Promise<void>
  consumeOAuthState(stateHash: string, now: string): Promise<OAuthState | null>
  findAdminUserById(userId: string): Promise<StorageAdminUser | null>
}
