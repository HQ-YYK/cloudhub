import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1ShareRepository } from '../../_lib/d1-share-repository.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import type { ShareRepository } from '../../_lib/share-repository.ts'
import { revokeShare, shareErrorResponse } from '../../_lib/share-service.ts'

interface ShareDeleteDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createShareRepository: (env: AuthEnv) => ShareRepository
}

export function createShareDeleteHandler(
  overrides: Partial<ShareDeleteDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: ShareDeleteDependencies = {
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
    if (context.request.method !== 'DELETE') return methodNotAllowed('DELETE')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    try {
      await revokeShare(
        dependencies.createAuthRepository(context.env),
        dependencies.createShareRepository(context.env),
        context.request,
        context.params.id as string,
      )
      return jsonResponse({ revoked: true })
    } catch (error) {
      return shareErrorResponse(error)
    }
  }
}

export const onRequest = createShareDeleteHandler()
