import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import { BlobStoreError, type BlobStore } from '../../_lib/blob-store.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import type { FileRepository } from '../../_lib/file-repository.ts'
import { deleteFile, FileServiceError, validateFileId } from '../../_lib/file-service.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import { createProductionBlobStore } from './upload.ts'

interface DeleteDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createFileRepository: (env: AuthEnv) => FileRepository
  createBlobStore: (env: AuthEnv) => BlobStore
}

function serviceErrorResponse(error: FileServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'invalid_parent') return jsonResponse({ error: 'invalid_request' }, 400)
  if (error.code === 'resource_not_found') return jsonResponse({ error: 'not_found' }, 404)
  if (error.code === 'conflict') return jsonResponse({ error: 'conflict' }, 409)
  return jsonResponse({ error: 'service_unavailable' }, 503)
}

export function createDeleteHandler(
  overrides: Partial<DeleteDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: DeleteDependencies = {
    createAuthRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1AuthRepository(env.DB)
    },
    createFileRepository: (env) => {
      if (!env.DB) throw new Error('database_configuration_missing')
      return createD1FileRepository(env.DB)
    },
    createBlobStore: createProductionBlobStore,
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'DELETE') return methodNotAllowed('DELETE')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)

    const rawId = context.params.id
    try {
      validateFileId(rawId)
    } catch (error) {
      if (error instanceof FileServiceError && error.code === 'invalid_parent') {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      throw error
    }

    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const item = await deleteFile(
        dependencies.createAuthRepository(context.env),
        dependencies.createFileRepository(context.env),
        () => dependencies.createBlobStore(context.env),
        context.request,
        rawId as string,
      )
      return jsonResponse({ deleted: item.deleted_at !== null })
    } catch (error) {
      if (error instanceof FileServiceError) return serviceErrorResponse(error)
      if (error instanceof BlobStoreError) return jsonResponse({ error: 'service_unavailable' }, 503)
      console.error('File delete request failed')
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createDeleteHandler()
