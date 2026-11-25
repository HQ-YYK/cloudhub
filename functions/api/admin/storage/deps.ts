import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1StorageRepository } from '../../../_lib/d1-storage-repository.ts'
import type {
  StorageAccountWithStats,
  StorageRepository,
} from '../../../_lib/storage-repository.ts'

export interface StorageAdminDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createStorageRepository: (env: AuthEnv) => StorageRepository
  fetchImpl: typeof fetch
}

export const defaultStorageAdminDependencies: StorageAdminDependencies = {
  createAuthRepository: (env) => {
    if (!env.DB) throw new Error('database_configuration_missing')
    return createD1AuthRepository(env.DB)
  },
  createStorageRepository: (env) => {
    if (!env.DB) throw new Error('database_configuration_missing')
    return createD1StorageRepository(env.DB)
  },
  fetchImpl: (input, init) => fetch(input, init),
}

export function accountView(account: StorageAccountWithStats) {
  return {
    id: account.id,
    googleEmail: account.google_email,
    status: account.status,
    quotaTotal: account.quota_total,
    quotaUsed: account.quota_used,
    quotaCheckedAt: account.quota_checked_at,
    fileCount: account.file_count,
    bytesStored: account.bytes_stored,
    createdAt: account.created_at,
  }
}
