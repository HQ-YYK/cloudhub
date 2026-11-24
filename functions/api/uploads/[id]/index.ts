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

export function createUploadStatusHandler(overrides: Partial<UploadDependencies> = {}): PagesFunction<AuthEnv> {
  const dependencies: UploadDependencies = { ...defaultUploadDependencies, ...overrides }
  return async (context) => {
    const id = context.params.id as string
    if (context.request.method === 'GET') {
      if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)
      const service = buildUploadService(context.env, dependencies)
      try {
        const result = await service.getProgress(context.request, id)
        return jsonResponse(result, 200)
      } catch (error) {
        if (error instanceof UploadServiceError) return uploadErrorResponse(error)
        console.error('Upload status request failed')
        return jsonResponse({ error: 'storage_unavailable' }, 503)
      }
    }

    if (context.request.method === 'DELETE') {
      if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
      if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)
      const service = buildUploadService(context.env, dependencies)
      try {
        const result = await service.cancel(context.request, id)
        return jsonResponse(result, 200)
      } catch (error) {
        if (error instanceof UploadServiceError) return uploadErrorResponse(error)
        console.error('Upload cancel request failed')
        return jsonResponse({ error: 'storage_unavailable' }, 503)
      }
    }

    return methodNotAllowed('GET, DELETE')
  }
}

export const onRequest = createUploadStatusHandler()
