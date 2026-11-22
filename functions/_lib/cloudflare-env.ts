import type { D1Database } from '@cloudflare/workers-types'

export interface AuthEnv {
  DB?: D1Database
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  STORAGE_ENCRYPTION_KEY?: string
}
