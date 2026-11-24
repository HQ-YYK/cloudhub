import type { PagesFunction } from '@cloudflare/workers-types'
import type { BlobStore } from '../../../../_lib/blob-store.ts'
import type { AuthEnv } from '../../../../_lib/cloudflare-env.ts'
import { createD1ShareRepository } from '../../../../_lib/d1-share-repository.ts'
import { methodNotAllowed } from '../../../../_lib/http.ts'
import { createProductionBlobStore } from '../../../../_lib/production-blob-store.ts'
import type { ShareRepository } from '../../../../_lib/share-repository.ts'
import { shareErrorResponse, streamPublicShare } from '../../../../_lib/share-service.ts'

interface PublicShareDownloadDependencies {
  createShareRepository: (env: AuthEnv) => ShareRepository
  createBlobStore: (env: AuthEnv) => BlobStore
}

export function createPublicShareDownloadHandler(
  overrides: Partial<PublicShareDownloadDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PublicShareDownloadDependencies = {
    createShareRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1ShareRepository(env.DB)
    },
    createBlobStore: createProductionBlobStore,
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'GET') return methodNotAllowed('GET')
    try {
      return await streamPublicShare(
        dependencies.createShareRepository(context.env),
        () => dependencies.createBlobStore(context.env),
        context.request,
        context.params.token as string,
      )
    } catch (error) {
      return shareErrorResponse(error)
    }
  }
}

export const onRequest = createPublicShareDownloadHandler()
