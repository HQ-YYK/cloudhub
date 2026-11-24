import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../../_lib/http.ts'
import { TrashServiceError } from '../../../_lib/trash-service.ts'
import {
  buildTrashService,
  defaultTrashDependencies,
  type TrashDependencies,
  trashErrorResponse,
} from '../deps.ts'

export function createTrashItemHandler(overrides: Partial<TrashDependencies> = {}): PagesFunction<AuthEnv> {
  const dependencies: TrashDependencies = { ...defaultTrashDependencies, ...overrides }
  return async (context) => {
    if (context.request.method !== 'DELETE') return methodNotAllowed('DELETE')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)

    const service = buildTrashService(context.env, dependencies)
    try {
      const result = await service.purgeOne(context.request, context.params.id as string)
      return jsonResponse(result, 200)
    } catch (error) {
      if (error instanceof TrashServiceError) return trashErrorResponse(error)
      console.error('Trash delete request failed')
      return jsonResponse({ error: 'storage_unavailable' }, 503)
    }
  }
}

export const onRequest = createTrashItemHandler()
