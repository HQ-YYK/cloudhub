import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import { createD1StorageRepository } from '../../_lib/d1-storage-repository.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import type { FileRepository, UploadRepository } from '../../_lib/file-repository.ts'
import { GoogleDriveClient } from '../../_lib/google-drive-client.ts'
import { jsonResponse } from '../../_lib/http.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'
import {
  createUploadService,
  type FixedLengthStreamFactory,
  type UploadDriveClient,
  UploadServiceError,
} from '../../_lib/upload-service.ts'

export interface UploadDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createFileRepository: (env: AuthEnv) => FileRepository & UploadRepository
  createStorageRepository: (env: AuthEnv) => StorageRepository
  createDriveClient: (env: AuthEnv, storageRepository: StorageRepository, fetchImpl: typeof fetch) => UploadDriveClient
  fetchImpl: typeof fetch
  createFixedLengthStream: FixedLengthStreamFactory
}

export const defaultUploadDependencies: UploadDependencies = {
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
  createFixedLengthStream: (length) =>
    new FixedLengthStream(length) as unknown as TransformStream<Uint8Array, Uint8Array>,
}

export function buildUploadService(env: AuthEnv, dependencies: UploadDependencies) {
  const storageRepository = dependencies.createStorageRepository(env)
  const fileRepository = dependencies.createFileRepository(env)
  return createUploadService({
    env,
    authRepository: dependencies.createAuthRepository(env),
    fileRepository,
    uploadRepository: fileRepository,
    storageRepository,
    driveClient: dependencies.createDriveClient(env, storageRepository, dependencies.fetchImpl),
    encryptionKey: env.STORAGE_ENCRYPTION_KEY ?? '',
    fetchImpl: dependencies.fetchImpl,
    createFixedLengthStream: dependencies.createFixedLengthStream,
  })
}

export function uploadErrorResponse(error: UploadServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'password_change_required') return jsonResponse({ error: 'password_change_required' }, 403)
  if (error.code === 'not_found') return jsonResponse({ error: 'not_found' }, 404)
  if (error.code === 'conflict') return jsonResponse({ error: 'conflict' }, 409)
  if (error.code === 'id_conflict') return jsonResponse({ error: 'id_conflict' }, 409)
  if (error.code === 'offset_mismatch') {
    return jsonResponse({ error: 'offset_mismatch', receivedBytes: error.receivedBytes }, 409)
  }
  if (error.code === 'upload_expired') return jsonResponse({ error: 'upload_expired' }, 410)
  if (error.code === 'size_mismatch') return jsonResponse({ error: 'storage_unavailable' }, 502)
  if (error.code === 'storage_not_connected') return jsonResponse({ error: 'storage_not_connected' }, 503)
  if (error.code === 'storage_not_configured') return jsonResponse({ error: 'storage_not_configured' }, 503)
  if (error.code === 'storage_reauth_required') return jsonResponse({ error: 'storage_reauth_required' }, 503)
  if (error.code === 'storage_full') {
    return jsonResponse({
      error: 'storage_full',
      required: error.required,
      largestAvailable: error.largestAvailable,
    }, 507)
  }
  if (error.code === 'storage_unavailable') return jsonResponse({ error: 'storage_unavailable' }, 503)
  return jsonResponse({ error: error.code }, 400)
}
