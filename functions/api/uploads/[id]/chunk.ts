import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { UploadServiceError } from '../../../_lib/upload-service.ts'
import {
  buildUploadService,
  defaultUploadDependencies,
  type UploadDependencies,
  uploadErrorResponse,
} from '../deps.ts'

export function createUploadChunkHandler(overrides: Partial<UploadDependencies> = {}): PagesFunction<AuthEnv> {
  const dependencies: UploadDependencies = { ...defaultUploadDependencies, ...overrides }
  return async (context) => {
    if (context.request.method !== 'PUT') return methodNotAllowed('PUT')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)

    const service = buildUploadService(context.env, dependencies)
    try {
      const result = await service.putChunk(context.request, context.params.id as string)
      return jsonResponse(result, 200)
    } catch (error) {
      if (error instanceof UploadServiceError) return uploadErrorResponse(error)
      console.error('Upload chunk request failed')
      return jsonResponse({ error: 'storage_unavailable' }, 503)
    }
  }
}

export const onRequest = createUploadChunkHandler()
