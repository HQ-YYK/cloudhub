import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1ShareRepository } from '../../../_lib/d1-share-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import type { ShareRepository } from '../../../_lib/share-repository.ts'
import { createShare, listSharesByFile, shareErrorResponse } from '../../../_lib/share-service.ts'

interface FileSharesDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createShareRepository: (env: AuthEnv) => ShareRepository
}

export function createFileSharesHandler(
  overrides: Partial<FileSharesDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: FileSharesDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createShareRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1ShareRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method === 'POST') {
      if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)

      let payload: unknown
      try {
        payload = await context.request.json()
      } catch {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      const expiresInDays = typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>).expiresInDays
        : undefined

      try {
        const share = await createShare(
          dependencies.createAuthRepository(context.env),
          dependencies.createShareRepository(context.env),
          context.request,
          context.params.id as string,
          expiresInDays,
          context.env.STORAGE_ENCRYPTION_KEY ?? '',
        )
        return jsonResponse({ share }, 201)
      } catch (error) {
        return shareErrorResponse(error)
      }
    }

    if (context.request.method === 'GET') {
      try {
        const shares = await listSharesByFile(
          dependencies.createAuthRepository(context.env),
          dependencies.createShareRepository(context.env),
          context.request,
          context.params.id as string,
          context.env.STORAGE_ENCRYPTION_KEY ?? '',
        )
        return jsonResponse({ shares })
      } catch (error) {
        return shareErrorResponse(error)
      }
    }

    return methodNotAllowed('GET, POST')
  }
}

export const onRequest = createFileSharesHandler()
