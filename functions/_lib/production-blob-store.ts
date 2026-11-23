import { BlobStoreError, type BlobStore } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'
import { createD1StorageRepository } from './d1-storage-repository.ts'
import { GoogleDriveStore } from './google-drive-store.ts'

export function createProductionBlobStore(env: AuthEnv): BlobStore {
  if (
    !env.DB
    || !env.GOOGLE_CLIENT_ID
    || !env.GOOGLE_CLIENT_SECRET
    || !env.STORAGE_ENCRYPTION_KEY
  ) {
    throw new BlobStoreError('unavailable', 'storage_not_configured')
  }
  return new GoogleDriveStore(env, createD1StorageRepository(env.DB))
}
