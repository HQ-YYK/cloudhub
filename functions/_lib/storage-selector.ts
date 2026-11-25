import { BlobStoreError } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'
import { refreshStorageQuota } from './storage-quota.ts'
import type { StorageAccount, StorageRepository } from './storage-repository.ts'

const QUOTA_MAX_AGE_MS = 10 * 60 * 1000
const MAX_QUOTA_REFRESHES = 3

export class StorageFullError extends Error {
  readonly required: number
  readonly largestAvailable: number

  constructor(required: number, largestAvailable: number) {
    super('storage_full')
    this.name = 'StorageFullError'
    this.required = required
    this.largestAvailable = largestAvailable
  }
}

function isStale(account: StorageAccount, nowMs: number) {
  if (account.quota_checked_at === null) return true
  return new Date(account.quota_checked_at).getTime() + QUOTA_MAX_AGE_MS <= nowMs
}

function availableBytes(account: StorageAccount, pendingBytes: number) {
  if (account.quota_total === null) return Number.POSITIVE_INFINITY
  const used = account.quota_used ?? 0
  return Math.max(0, account.quota_total - used - pendingBytes)
}

export async function selectStorageAccount(
  env: AuthEnv,
  repository: StorageRepository,
  fetchImpl: typeof fetch,
  fileSize: number,
  now: () => Date = () => new Date(),
): Promise<StorageAccount> {
  const accounts = (await repository.listAccounts()).filter((account) => account.status === 'active')
  if (accounts.length === 0) throw new BlobStoreError('unavailable', 'storage_not_connected')

  const nowMs = now().getTime()
  const stale = accounts.filter((account) => isStale(account, nowMs))
  const refreshCandidates = stale.slice(0, MAX_QUOTA_REFRESHES)
  const refreshed = new Map<number, { quotaTotal: number | null; quotaUsed: number | null; checkedAt: string }>()

  for (const account of refreshCandidates) {
    try {
      const quota = await refreshStorageQuota(env, repository, account.id, fetchImpl)
      const checkedAt = now().toISOString()
      await repository.setAccountQuota(account.id, quota.quotaTotal, quota.quotaUsed, checkedAt)
      refreshed.set(account.id, { quotaTotal: quota.quotaTotal, quotaUsed: quota.quotaUsed, checkedAt })
    } catch {
      // Keep the old values; never-checked accounts that fail are skipped below.
    }
  }

  let best: { account: StorageAccount; available: number } | null = null
  let largestAvailable = 0
  for (const account of accounts) {
    const update = refreshed.get(account.id)
    if (update) {
      account.quota_total = update.quotaTotal
      account.quota_used = update.quotaUsed
      account.quota_checked_at = update.checkedAt
    } else if (account.quota_checked_at === null) {
      continue
    }

    const pending = await repository.pendingBytesByAccount(account.id)
    const available = availableBytes(account, pending)
    if (available > largestAvailable) largestAvailable = available
    if (available >= fileSize && (best === null || available > best.available)) {
      best = { account, available }
    }
  }

  if (!best) throw new StorageFullError(fileSize, largestAvailable)
  return best.account
}
