import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1ShareRepository } from '../../_lib/d1-share-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../_lib/http.ts'
import type { ShareRepository } from '../../_lib/share-repository.ts'
import { listSharesByOwner, shareErrorResponse } from '../../_lib/share-service.ts'

interface SharesIndexDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createShareRepository: (env: AuthEnv) => ShareRepository
}

export function createSharesIndexHandler(
  overrides: Partial<SharesIndexDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: SharesIndexDependencies = {
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
    if (context.request.method !== 'GET') return methodNotAllowed('GET')
    try {
      const shares = await listSharesByOwner(
        dependencies.createAuthRepository(context.env),
        dependencies.createShareRepository(context.env),
        context.request,
        context.env.STORAGE_ENCRYPTION_KEY ?? '',
      )
      return jsonResponse({ shares })
    } catch (error) {
      return shareErrorResponse(error)
    }
  }
}

export const onRequest = createSharesIndexHandler()
