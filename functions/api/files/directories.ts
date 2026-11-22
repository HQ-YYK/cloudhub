import type { PagesFunction } from '@cloudflare/workers-types'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import { createDirectory, FileServiceError, publicFileRecord } from '../../_lib/file-service.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'

function serviceErrorResponse(error: FileServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'password_change_required') return jsonResponse({ error: 'password_change_required' }, 403)
  if (error.code === 'invalid_name') return jsonResponse({ error: 'invalid_name' }, 400)
  if (error.code === 'invalid_parent') return jsonResponse({ error: 'not_found' }, 404)
  return jsonResponse({ error: 'conflict' }, 409)
}

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed('POST')
  if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
  const authRepository = createD1AuthRepository(context.env.DB)
  const fileRepository = createD1FileRepository(context.env.DB)

  try {
    let body: { parent_id?: unknown; name?: unknown }
    try {
      const parsed: unknown = await context.request.json()
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      body = parsed as { parent_id?: unknown; name?: unknown }
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }
    const parentId = body.parent_id === null || body.parent_id === undefined ? null : body.parent_id
    if (parentId !== null && typeof parentId !== 'string') return jsonResponse({ error: 'invalid_request' }, 400)
    const item = await createDirectory(authRepository, fileRepository, context.request, parentId, body.name)
    return jsonResponse({ item: publicFileRecord(item) }, 201)
  } catch (error) {
    if (error instanceof FileServiceError) return serviceErrorResponse(error)
    console.error('Directory request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
