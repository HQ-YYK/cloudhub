import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import type { TrashRepository } from '../../_lib/file-repository.ts'
import { GoogleDriveClient } from '../../_lib/google-drive-client.ts'
import { jsonResponse } from '../../_lib/http.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'
import {
  createTrashService,
  TrashServiceError,
  type TrashDriveClient,
} from '../../_lib/trash-service.ts'

export interface TrashDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createTrashRepository: (env: AuthEnv) => TrashRepository
  createStorageRepository: (env: AuthEnv) => StorageRepository
  createDriveClient: (env: AuthEnv, storageRepository: StorageRepository, fetchImpl: typeof fetch) => TrashDriveClient
  fetchImpl: typeof fetch
  now?: () => Date
}

export const defaultTrashDependencies: TrashDependencies = {
  createAuthRepository: (env) => {
    if (!env.DB) throw new Error('database_configuration_missing')
    return createD1AuthRepository(env.DB)
  },
  createTrashRepository: (env) => {
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

export function buildTrashService(env: AuthEnv, dependencies: TrashDependencies) {
  const storageRepository = dependencies.createStorageRepository(env)
  return createTrashService({
    authRepository: dependencies.createAuthRepository(env),
    trashRepository: dependencies.createTrashRepository(env),
    driveClient: dependencies.createDriveClient(env, storageRepository, dependencies.fetchImpl),
    now: dependencies.now,
  })
}

export function trashErrorResponse(error: TrashServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'password_change_required') return jsonResponse({ error: 'password_change_required' }, 403)
  if (error.code === 'not_found') return jsonResponse({ error: 'not_found' }, 404)
  if (error.code === 'conflict') return jsonResponse({ error: 'conflict' }, 409)
  if (error.code === 'purged') return jsonResponse({ error: 'purged' }, 410)
  if (error.code === 'storage_unavailable') return jsonResponse({ error: 'storage_unavailable' }, 503)
  return jsonResponse({ error: error.code }, 400)
}
