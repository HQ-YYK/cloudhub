import type { PagesFunction } from '@cloudflare/workers-types'
import { createAzureClientCredentialsAuth } from '../../_lib/azure-blob-auth.ts'
import { AzureBlobStore } from '../../_lib/azure-blob-store.ts'
import type { BlobStore } from '../../_lib/blob-store.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import { createD1AuthRepository } from '../../_lib/d1-auth-repository.ts'
import { createD1FileRepository } from '../../_lib/d1-file-repository.ts'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { FileRepository } from '../../_lib/file-repository.ts'
import { FileServiceError, publicFileRecord } from '../../_lib/file-service.ts'
import { uploadFile } from '../../_lib/file-upload-service.ts'
import { jsonResponse, methodNotAllowed, sameOriginRequest } from '../../_lib/http.ts'
import {
  MultipartUploadError,
  parseUploadMultipart,
} from '../../_lib/multipart-upload-parser.ts'

interface UploadDependencies {
  createAuthRepository: (env: AuthEnv) => AuthRepository
  createFileRepository: (env: AuthEnv) => FileRepository
  createBlobStore: (env: AuthEnv) => BlobStore
}

function serviceErrorResponse(error: FileServiceError) {
  if (error.code === 'unauthorized') return jsonResponse({ error: 'unauthorized' }, 401)
  if (error.code === 'invalid_name' || error.code === 'invalid_mime' || error.code === 'invalid_body') {
    return jsonResponse({ error: error.code }, 400)
  }
  if (error.code === 'too_large') return jsonResponse({ error: 'too_large' }, 413)
  if (error.code === 'invalid_parent' || error.code === 'resource_not_found') {
    return jsonResponse({ error: 'not_found' }, 404)
  }
  if (error.code === 'conflict') return jsonResponse({ error: 'conflict' }, 409)
  return jsonResponse({ error: 'service_unavailable' }, 503)
}

export function createProductionBlobStore(env: AuthEnv) {
  const tenantId = env.AZURE_TENANT_ID
  const clientId = env.AZURE_CLIENT_ID
  const clientSecret = env.AZURE_CLIENT_SECRET
  const accountName = env.AZURE_STORAGE_ACCOUNT
  const containerName = env.AZURE_STORAGE_CONTAINER
  const endpoint = env.AZURE_STORAGE_BLOB_ENDPOINT
  if (
    !tenantId
    || !clientId
    || !clientSecret
    || !accountName
    || !containerName
  ) {
    throw new Error('azure_configuration_missing')
  }
  if (endpoint !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      throw new Error('azure_endpoint_invalid')
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
    ) {
      throw new Error('azure_endpoint_invalid')
    }
  }
  const tokenProvider = createAzureClientCredentialsAuth({
    tenantId,
    clientId,
    clientSecret,
  })
  return new AzureBlobStore({
    accountName,
    containerName,
    endpoint,
    tokenProvider,
  })
}

export function createUploadHandler(
  overrides: Partial<UploadDependencies> = {},
): PagesFunction<AuthEnv> {
  const dependencies: UploadDependencies = {
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
    if (context.request.method !== 'POST') return methodNotAllowed('POST')
    if (!sameOriginRequest(context.request)) return jsonResponse({ error: 'forbidden' }, 403)
    if (!context.env.DB) return jsonResponse({ error: 'service_unavailable' }, 503)

    try {
      const parsed = await parseUploadMultipart(context.request)
      const authRepository = dependencies.createAuthRepository(context.env)
      const fileRepository = dependencies.createFileRepository(context.env)
      const blobStore = dependencies.createBlobStore(context.env)
      const headers = new Headers()
      const cookie = context.request.headers.get('Cookie')
      if (cookie !== null) headers.set('Cookie', cookie)
      headers.set('Content-Length', String(parsed.body.byteLength))
      const fileRequest = new Request(context.request.url, {
        method: 'POST',
        headers,
        body: parsed.body,
      })
      const item = await uploadFile(
        authRepository,
        fileRepository,
        blobStore,
        fileRequest,
        {
          name: parsed.fileName,
          parentId: parsed.parentId,
          mimeType: parsed.mimeType,
        },
      )
      return jsonResponse({ item: publicFileRecord(item) }, 201)
    } catch (error) {
      if (error instanceof MultipartUploadError) {
        return jsonResponse({ error: error.code }, error.code === 'too_large' ? 413 : 400)
      }
      if (error instanceof FileServiceError) return serviceErrorResponse(error)
      console.error('File upload request failed', error)
      return jsonResponse({ error: 'service_unavailable' }, 503)
    }
  }
}

export const onRequest = createUploadHandler()
