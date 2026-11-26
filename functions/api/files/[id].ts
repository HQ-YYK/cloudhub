import type { PagesFunction } from '@cloudflare/workers-types'
import { getAuthenticatedUser } from '../../_lib/auth.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import { BlobStoreError, type BlobStore } from '../../_lib/blob-store.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import { createD1FileTreeRepository } from '../../_lib/d1-file-tree-repository.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import type {
  FileRepository,
  FolderDeleteRepository,
  MoveRepository,
  TrashRepository,
  UploadRepository,
} from '../../_lib/file-repository.ts'
import { deleteItem, FileServiceError, validateFileId } from '../../_lib/file-service.ts'
import { GoogleDriveClient } from '../../_lib/google-drive-client.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import {
  createMoveService,
  type MoveDriveClient,
  type MovePatch,
  MoveServiceError,
} from '../../_lib/move-service.ts'
import { createProductionBlobStore } from '../../_lib/production-blob-store.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'

interface DeleteDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createFileRepository: (env: AuthEnv) => FileRepository & FolderDeleteRepository
  createBlobStore: (env: AuthEnv, accountId: number) => BlobStore
}

interface PatchDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createFileRepository: (env: AuthEnv) => MoveRepository & UploadRepository & TrashRepository
  createStorageRepository: (env: AuthEnv) => StorageRepository
  createDriveClient: (env: AuthEnv, storageRepository: StorageRepository, fetchImpl: typeof fetch) => MoveDriveClient
  fetchImpl: typeof fetch
}

function serviceErrorResponse(error: FileServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'password_change_required') return jsonResponse({ error: 'password_change_required' }, 403)
  if (error.code === 'invalid_parent') return jsonResponse({ error: 'invalid_request' }, 400)
  if (error.code === 'resource_not_found') return jsonResponse({ error: 'not_found' }, 404)
  if (error.code === 'conflict') return jsonResponse({ error: 'conflict' }, 409)
  if (error.code === 'folder_too_large') return jsonResponse({ error: 'folder_too_large' }, 400)
  if (error.code === 'folder_busy') return jsonResponse({ error: 'folder_busy' }, 409)
  return jsonResponse({ error: 'storage_unavailable' }, 503)
}

function moveErrorResponse(error: MoveServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'password_change_required') return jsonResponse({ error: 'password_change_required' }, 403)
  if (error.code === 'invalid_request') return jsonResponse({ error: 'invalid_request' }, 400)
  if (error.code === 'invalid_name') return jsonResponse({ error: 'invalid_name' }, 400)
  if (error.code === 'not_found') return jsonResponse({ error: 'not_found' }, 404)
  if (error.code === 'conflict') return jsonResponse({ error: 'conflict' }, 409)
  if (error.code === 'legacy_file') return jsonResponse({ error: 'legacy_file' }, 409)
  if (error.code === 'invalid_move') return jsonResponse({ error: 'invalid_move' }, 409)
  if (error.code === 'not_ready') return jsonResponse({ error: 'not_ready' }, 409)
  if (error.code === 'storage_not_connected') return jsonResponse({ error: 'storage_not_connected' }, 503)
  return jsonResponse({ error: 'storage_unavailable' }, 503)
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
      return {
        ...createD1FileRepository(env.DB),
        ...createD1FileTreeRepository(env.DB),
      }
    },
    createBlobStore: (env, accountId) => createProductionBlobStore(env, accountId),
    ...overrides,
  }

  return async (context) => {
    if (context.request.method !== 'DELETE') return methodNotAllowed('DELETE, PATCH')
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

    if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)

    try {
      const authRepository = dependencies.createAuthRepository(context.env)
      const fileRepository = dependencies.createFileRepository(context.env)
      const user = await getAuthenticatedUser(authRepository, context.request)
      const accountId = user
        ? (await fileRepository.findFile(user.id, rawId as string))?.storage_account_id ?? 1
        : 1

      const result = await deleteItem(
        authRepository,
        fileRepository,
        () => dependencies.createBlobStore(context.env, accountId),
        context.request,
        rawId as string,
      )
      return jsonResponse(result)
    } catch (error) {
      if (error instanceof FileServiceError) return serviceErrorResponse(error)
      if (error instanceof BlobStoreError) return jsonResponse({ error: 'storage_unavailable' }, 503)
      console.error('File delete request failed')
      return jsonResponse({ error: 'storage_unavailable' }, 503)
    }
  }
}

export const defaultPatchDependencies: PatchDependencies = {
  createAuthRepository: (env) => {
    if (!env.DB) throw new Error('database_configuration_missing')
    return createD1AuthRepository(env.DB)
  },
  createFileRepository: (env) => {
    if (!env.DB) throw new Error('database_configuration_missing')
    return createD1FileRepository(env.DB)
  },
  createStorageRepository: (env) => {
    if (!env.DB) throw new Error('database_configuration_missing')
    return createD1StorageRepository(env.DB)
  },
  createDriveClient: (env, storageRepository, fetchImpl) =>
    new GoogleDriveClient(env, storageRepository, fetchImpl),
  fetchImpl: (input, init) => fetch(input, init),
}

export function createPatchHandler(
  overrides: Partial<PatchDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: PatchDependencies = { ...defaultPatchDependencies, ...overrides }

  return async (context) => {
    if (context.request.method !== 'PATCH') return methodNotAllowed('DELETE, PATCH')
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

    if (!context.env.DB) return jsonResponse({ error: 'storage_unavailable' }, 503)

    const text = await context.request.text()
    if (text.length > 4096) return jsonResponse({ error: 'invalid_request' }, 400)

    let body: MovePatch
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse({ error: 'invalid_request' }, 400)
      }
      body = parsed as MovePatch
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }
    const hasEncName = Object.prototype.hasOwnProperty.call(body, 'encName')
    const hasNameKey = Object.prototype.hasOwnProperty.call(body, 'nameKey')
    const hasParentId = Object.prototype.hasOwnProperty.call(body, 'parentId')
    if (!hasEncName && !hasNameKey && !hasParentId) return jsonResponse({ error: 'invalid_request' }, 400)
    if (hasEncName !== hasNameKey) return jsonResponse({ error: 'invalid_request' }, 400)
    if (hasParentId && body.parentId !== null && typeof body.parentId !== 'string') {
      return jsonResponse({ error: 'invalid_request' }, 400)
    }

    try {
      const storageRepository = dependencies.createStorageRepository(context.env)
      const service = createMoveService({
        authRepository: dependencies.createAuthRepository(context.env),
        fileRepository: dependencies.createFileRepository(context.env),
        storageRepository,
        driveClient: dependencies.createDriveClient(context.env, storageRepository, dependencies.fetchImpl),
      })
      const item = await service.patch(context.request, rawId as string, body)
      return jsonResponse({ item })
    } catch (error) {
      if (error instanceof MoveServiceError) return moveErrorResponse(error)
      console.error('File move request failed')
      return jsonResponse({ error: 'storage_unavailable' }, 503)
    }
  }
}

export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (context.request.method === 'PATCH') return createPatchHandler()(context)
  return createDeleteHandler()(context)
}
