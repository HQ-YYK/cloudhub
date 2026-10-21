import type { PagesFunction } from '@cloudflare/workers-types'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import { FileServiceError, listFiles, publicFileRecord } from '../../_lib/file-service.ts'
import { jsonResponse, methodNotAllowed } from '../../_lib/http.ts'

function serviceErrorResponse(error: FileServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'invalid_name') return jsonResponse({ error: 'invalid_name' }, 400)
  if (error.code === 'invalid_parent' || error.code === 'resource_not_found') {
    return jsonResponse({ error: 'not_found' }, 404)
  }
  return jsonResponse({ error: 'conflict' }, 409)
}

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method !== 'GET') return methodNotAllowed('GET')
  if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)
  const authRepository = createD1AuthRepository(context.env.DB)
  const fileRepository = createD1FileRepository(context.env.DB)

  try {
    const parentId = new URL(context.request.url).searchParams.get('parent_id')
    const items = await listFiles(authRepository, fileRepository, context.request, parentId)
    return jsonResponse({ items: items.map(publicFileRecord) })
  } catch (error) {
    if (error instanceof FileServiceError) return serviceErrorResponse(error)
    console.error('File request failed', error)
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }
}
