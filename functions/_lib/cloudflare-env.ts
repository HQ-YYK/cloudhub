import type { D1Database } from '@cloudflare/workers-types'

export interface AuthEnv {
  DB?: D1Database
}
