import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser, sha256 } from '../../_lib/auth.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import { jsonResponse } from '../../_lib/http.ts'

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function createStorageConnectHandler(
  overrides: Partial<{ createAuthRepository: (env: AuthEnv) => ReturnType<typeof createD1AuthRepository>, createStorageRepository: (env: AuthEnv) => ReturnType<typeof createD1StorageRepository> }> = {},
): PagesFunction<AuthEnv> {
  const dependencies = {
    createAuthRepository: (env: AuthEnv) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createStorageRepository: (env: AuthEnv) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1StorageRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET') {
      return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    }
    if (!context.env.DB) return jsonResponse({ error: 'storage_not_configured' }, 503)
    if (!context.env.GOOGLE_CLIENT_ID || !context.env.GOOGLE_CLIENT_SECRET || !context.env.STORAGE_ENCRYPTION_KEY) {
      return jsonResponse({ error: 'storage_not_configured' }, 503)
    }

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.role !== 'admin') return jsonResponse({ error: 'forbidden' }, 403)
      if (user.mustChangePassword) return jsonResponse({ error: 'forbidden' }, 403)

      const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
      const stateHash = await sha256(state)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
      const storageRepository = dependencies.createStorageRepository(context.env)
      await storageRepository.deleteExpiredOAuthStates(now.toISOString())
      await storageRepository.createOAuthState(stateHash, user.id, expiresAt)

      const redirectUri = new URL('/api/storage/callback', context.request.url)
      const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authorize.searchParams.set('client_id', context.env.GOOGLE_CLIENT_ID)
      authorize.searchParams.set('redirect_uri', redirectUri.toString())
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/drive.file')
      authorize.searchParams.set('access_type', 'offline')
      authorize.searchParams.set('prompt', 'consent')
      authorize.searchParams.set('state', state)
      return new Response(null, { status: 302, headers: { Location: authorize.toString() } })
    } catch (error) {
      console.error('Storage connect failed', error instanceof Error ? error.name : 'unknown_error')
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createStorageConnectHandler()
