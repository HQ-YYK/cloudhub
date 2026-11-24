import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1ShareRepository } from '../../../../_lib/d1-share-repository.ts'
import { jsonResponse, methodNotAllowed } from '../../../../_lib/http.ts'
import type { ShareRepository } from '../../../../_lib/share-repository.ts'
import { getPublicShareMetadata, shareErrorResponse } from '../../../../_lib/share-service.ts'

interface PublicShareMetadataDependencies {
  createShareRepository: (env: AuthEnv) => ShareRepository
}

export function createPublicShareMetadataHandler(
  overrides: Partial<PublicShareMetadataDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PublicShareMetadataDependencies = {
    createShareRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1ShareRepository(env.DB)
    },
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET') return methodNotAllowed('GET')
    try {
      const metadata = await getPublicShareMetadata(
        dependencies.createShareRepository(context.env),
        context.params.token as string,
      )
      return jsonResponse(metadata, 200, { 'X-Robots-Tag': 'noindex' })
    } catch (error) {
      return shareErrorResponse(error)
    }
  }
}

export const onRequest = createPublicShareMetadataHandler()
