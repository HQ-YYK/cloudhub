import { BlobStoreError, type BlobStore } from './blob-store.ts'
import type { AuthEnv } from './cloudflare-env.ts'

export function createProductionBlobStore(env: AuthEnv): BlobStore {
  void env
  throw new BlobStoreError('unavailable', 'storage_not_configured')
}
