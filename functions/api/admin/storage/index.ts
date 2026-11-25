import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser, sha256 } from '../../../_lib/auth.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { MAX_STORAGE_ACCOUNTS } from '../../../_lib/storage-repository.ts'
import { accountView, defaultStorageAdminDependencies, type StorageAdminDependencies } from './deps.ts'

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function createAdminStorageHandler(
  overrides: Partial<StorageAdminDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: StorageAdminDependencies = { ...defaultStorageAdminDependencies, ...overrides }

  return async (context) => {
    if (context.request.method !== 'GET' && context.request.method !== 'POST') {
      return methodNotAllowed('GET, POST')
    }
    if (context.request.method === 'POST' && !sameOriginRequest(context.request)) {
      return jsonResponse({ error: 'forbidden' }, 403)
    }
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.role !== 'admin' || user.mustChangePassword) {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      const storageRepository = dependencies.createStorageRepository(context.env)

      if (context.request.method === 'GET') {
        const accounts = await storageRepository.listAccountsWithStats()
        return jsonResponse({ accounts: accounts.map(accountView) })
      }

      if (
        !context.env.GOOGLE_CLIENT_ID
        || !context.env.GOOGLE_CLIENT_SECRET
        || !context.env.STORAGE_ENCRYPTION_KEY
      ) {
        return jsonResponse({ error: 'storage_not_configured' }, 503)
      }

      if ((await storageRepository.countAccounts()) >= MAX_STORAGE_ACCOUNTS) {
        return jsonResponse({ error: 'too_many_accounts' }, 400)
      }

      const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
      const stateHash = await sha256(state)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
      await storageRepository.deleteExpiredOAuthStates(now.toISOString())
      await storageRepository.createOAuthState(stateHash, user.id, expiresAt)

      const redirectUri = new URL('/api/storage/callback', context.request.url)
      const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authorize.searchParams.set('client_id', context.env.GOOGLE_CLIENT_ID)
      authorize.searchParams.set('redirect_uri', redirectUri.toString())
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/drive.file')
      authorize.searchParams.set('access_type', 'offline')
      authorize.searchParams.set('prompt', 'select_account consent')
      authorize.searchParams.set('state', state)
      return jsonResponse({ url: authorize.toString() })
    } catch (error) {
      console.error('Admin storage request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createAdminStorageHandler()
