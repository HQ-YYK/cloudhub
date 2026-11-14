import type { D1Database } from '@cloudflare/workers-types'

export interface AuthEnv {
  DB?: D1Database
  AZURE_TENANT_ID?: string
  AZURE_CLIENT_ID?: string
  AZURE_CLIENT_SECRET?: string
  AZURE_STORAGE_ACCOUNT?: string
  AZURE_STORAGE_CONTAINER?: string
  AZURE_STORAGE_BLOB_ENDPOINT?: string
}
