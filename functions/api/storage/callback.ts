import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import { clearAccessTokenCache } from '../../_lib/google-oauth.ts'
import { encryptSecret } from '../../_lib/secret-box.ts'
import { sha256 } from '../../_lib/auth.ts'

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location } })
}

function base64UrlDecode(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function errorPage() {
  return new Response('Invalid or expired authorization state.', {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export function createStorageCallbackHandler(
  overrides: Partial<{
    createStorageRepository: (env: AuthEnv) => ReturnType<typeof createD1StorageRepository>
    fetchImpl: typeof fetch
  }> = {},
): PagesFunction<AuthEnv> {
  const dependencies = {
    createStorageRepository: (env: AuthEnv) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1StorageRepository(env.DB)
    },
    fetchImpl: fetch,
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET') {
      return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    }
    if (
      !context.env.DB
      || !context.env.GOOGLE_CLIENT_ID
      || !context.env.GOOGLE_CLIENT_SECRET
      || !context.env.STORAGE_ENCRYPTION_KEY
    ) {
      return redirect('/?storage=failed')
    }

    try {
      const url = new URL(context.request.url)
      const state = url.searchParams.get('state')
      if (!state) return errorPage()

      const stateHash = await sha256(state)
      const storageRepository = dependencies.createStorageRepository(context.env)
      const oauthState = await storageRepository.consumeOAuthState(
        stateHash,
        new Date().toISOString(),
      )
      if (!oauthState) return errorPage()

      const admin = await storageRepository.findAdminUserById(oauthState.user_id)
      if (!admin) return redirect('/?storage=failed')

      if (url.searchParams.has('error')) return redirect('/?storage=denied')

      const code = url.searchParams.get('code')
      if (!code) return redirect('/?storage=failed')

      const redirectUri = new URL('/api/storage/callback', context.request.url).toString()
      const tokenBody = new URLSearchParams({
        code,
        client_id: context.env.GOOGLE_CLIENT_ID,
        client_secret: context.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      })
      const tokenResponse = await dependencies.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      })
      if (!tokenResponse.ok) return redirect('/?storage=failed')
      const tokenPayload = await tokenResponse.json() as {
        refresh_token?: string
        id_token?: string
        access_token?: string
      }
      if (!tokenPayload.refresh_token || !tokenPayload.access_token || !tokenPayload.id_token) {
        return redirect('/?storage=failed')
      }

      const idPayloadSegment = tokenPayload.id_token.split('.')[1]
      if (!idPayloadSegment) return redirect('/?storage=failed')
      const idPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(idPayloadSegment))) as {
        email?: string
      }
      if (!idPayload.email) return redirect('/?storage=failed')

      const existing = await storageRepository.getAccount()
      let rootFolderId: string | null = null
      if (existing?.root_folder_id) {
        const existingResponse = await dependencies.fetchImpl(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing.root_folder_id)}?fields=id,trashed`,
          { headers: { Authorization: `Bearer ${tokenPayload.access_token}` } },
        )
        if (existingResponse.ok) {
          const existingPayload = await existingResponse.json() as { id?: string, trashed?: boolean }
          if (existingPayload.id === existing.root_folder_id && existingPayload.trashed !== true) {
            rootFolderId = existing.root_folder_id
          }
        }
      }

      if (!rootFolderId) {
        const folderResponse = await dependencies.fetchImpl('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenPayload.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'CloudHub',
            mimeType: 'application/vnd.google-apps.folder',
          }),
        })
        if (!folderResponse.ok) return redirect('/?storage=failed')
        const folderPayload = await folderResponse.json() as { id?: string }
        if (!folderPayload.id) return redirect('/?storage=failed')
        rootFolderId = folderPayload.id
      }

      const encrypted = await encryptSecret(
        tokenPayload.refresh_token,
        context.env.STORAGE_ENCRYPTION_KEY,
      )
      const now = new Date().toISOString()
      await storageRepository.upsertAccount({
        id: 1,
        google_email: idPayload.email,
        refresh_token_ciphertext: encrypted.ciphertext,
        refresh_token_iv: encrypted.iv,
        root_folder_id: rootFolderId,
        connected_by: oauthState.user_id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      })
      clearAccessTokenCache()
      return redirect('/?storage=connected')
    } catch (error) {
      console.error('Storage callback failed', error instanceof Error ? error.name : 'unknown_error')
      return redirect('/?storage=failed')
    }
  }
}

export const onRequest = createStorageCallbackHandler()
