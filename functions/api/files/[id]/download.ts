import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../../_lib/auth-repository.ts'
import { getAuthenticatedUser } from '../../../_lib/auth.ts'
import { BlobStoreError, type BlobStore } from '../../../_lib/blob-store.ts'
import type { AuthEnv } from '../../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../../_lib/d1-auth-repository.ts'
import { createD1FileRepository } from '../../../_lib/d1-file-repository.ts'
import type { FileRepository } from '../../../_lib/file-repository.ts'
import { FileServiceError, validateFileId } from '../../../_lib/file-service.ts'
import { jsonResponse, methodNotAllowed } from '../../../_lib/http.ts'
import { createProductionBlobStore } from '../../../_lib/production-blob-store.ts'

interface DownloadDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createFileRepository: (env: AuthEnv) => FileRepository
  createBlobStore: (env: AuthEnv) => BlobStore
}

function contentDisposition(fileName: string) {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\\r\n/;]/gu, '_')
    .trim()
    .slice(0, 180) || 'download'
  const encoded = encodeURIComponent(fileName)
    .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function invalidFileIdResponse() {
  return jsonResponse({ error: 'invalid_request' }, 400)
}

function unavailableResponse() {
  return jsonResponse({ error: 'storage_unavailable' }, 503)
}

export function createDownloadHandler(
  overrides: Partial<DownloadDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: DownloadDependencies = {
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
    if (context.request.method !== 'GET') return methodNotAllowed('GET')

    const rawId = context.params.id
    try {
      validateFileId(rawId)
    } catch (error) {
      if (error instanceof FileServiceError && error.code === 'invalid_parent') {
        return invalidFileIdResponse()
      }
      throw error
    }

    if (!context.env.DB) return unavailableResponse()

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
      if (user.mustChangePassword) return jsonResponse({ error: 'password_change_required' }, 403)

      const fileRepository = dependencies.createFileRepository(context.env)
      const record = await fileRepository.findFile(user.id, rawId as string)
      const sizeBytes = record?.size_bytes
      if (
        !record
        || record.kind !== 'file'
        || record.storage_status !== 'ready'
        || record.deleted_at !== null
        || record.object_key === null
        || typeof sizeBytes !== 'number'
        || !Number.isSafeInteger(sizeBytes)
        || sizeBytes < 0
      ) {
        return jsonResponse({ error: 'not_found' }, 404)
      }

      const blobStore = dependencies.createBlobStore(context.env)
      const blob = await blobStore.get(record.object_key)
      if (!Number.isSafeInteger(blob.sizeBytes) || blob.sizeBytes < 0) {
        return unavailableResponse()
      }

      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': contentDisposition(record.name),
        'Content-Type': blob.contentType ?? record.mime_type ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      })
      headers.set('Content-Length', String(blob.sizeBytes))
      return new Response(blob.body, { status: 200, headers })
    } catch (error) {
      if (error instanceof BlobStoreError) return unavailableResponse()
      console.error('File download request failed')
      return unavailableResponse()
    }
  }
}

export const onRequest = createDownloadHandler()
