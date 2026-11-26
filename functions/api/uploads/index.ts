import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import type { CreateUploadBody } from '../../_lib/upload-service.ts'
import { UploadServiceError } from '../../_lib/upload-service.ts'
import {
  buildUploadService,
  defaultUploadDependencies,
  type UploadDependencies,
  uploadErrorResponse,
} from './deps.ts'

export function createUploadHandler(overrides: Partial<UploadDependencies> = {}): PagesFunction<AuthEnv> {
  const dependencies: UploadDependencies = { ...defaultUploadDependencies, ...overrides }
  return async (context) => {
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)

    const service = buildUploadService(context.env, dependencies)
    try {
      const text = await context.request.text()
      if (text.length > 4096) return jsonResponse({ error: 'invalid_request' }, 400)
      let body: CreateUploadBody
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return jsonResponse({ error: 'invalid_request' }, 400)
        }
        body = parsed as CreateUploadBody
      } catch {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      const created = await service.create(context.request, body)
      return jsonResponse(created, 201)
    } catch (error) {
      if (error instanceof UploadServiceError) return uploadErrorResponse(error)
      console.error('Upload create request failed')
      return jsonResponse({ error: 'storage_unavailable' }, 503)
    }
  }
}

export const onRequest = createUploadHandler()
