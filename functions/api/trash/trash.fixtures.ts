import type { D1Database, PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { BlobStoreError } from '../../_lib/blob-store.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import {
  FileRepositoryConflictError,
  type FileRecord,
  type TrashItem,
  type TrashRepository,
  type TrashTreeRepository,
} from '../../_lib/file-repository.ts'
import type { StorageRepository } from '../../_lib/storage-repository.ts'
import type { TrashDriveClient } from '../../_lib/trash-service.ts'
import type { TrashDependencies } from './deps.ts'

export const owner = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', role: 'user' as const, must_change_password: 0 }
export const otherOwner = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', role: 'user' as const, must_change_password: 0 }
export const fileId = '33333333-3333-4333-8333-333333333333'
export const objectKey = `objects/${fileId}`
export const now = new Date('2030-01-15T00:00:00.000Z')
export const sessionCookie = 'cloudhub_session=valid-token'

export function authRepository(user = owner, authenticated = true): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => authenticated
      ? { session_id: 'session', ...user }
      : null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async () => undefined,
    listUsers: async () => [],
    findUserById: async () => null,
    createUser: async () => { throw new Error('not_used') },
    updatePassword: async () => undefined,
    setDisabled: async () => undefined,
    revokeOtherSessions: async () => undefined,
  }
}

export function storageRepository(): StorageRepository {
  return {
    getAccount: async () => null,
    listAccounts: async () => [],
    listAccountsWithStats: async () => [],
    countAccounts: async () => 0,
    findAccountByEmail: async () => null,
    createAccount: async () => { throw new Error('not_implemented') },
    updateAccountTokens: async () => null,
    setAccountStatus: async () => null,
    setAccountReauth: async () => undefined,
    setAccountQuota: async () => undefined,
    deleteAccount: async () => undefined,
    countFilesByAccount: async () => 0,
    pendingBytesByAccount: async () => 0,
    findUserFolder: async () => null,
    setUserFolderIfEmpty: async () => false,
    deleteExpiredOAuthStates: async () => undefined,
    createOAuthState: async () => undefined,
    consumeOAuthState: async () => null,
    findAdminUserById: async () => null,
  }
}

export function env(): AuthEnv {
  return { DB: {} as D1Database }
}

export function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId,
    owner_id: owner.id,
    parent_id: null,
    kind: 'file',
    name: 'file.txt',
    name_key: 'file.txt',
    object_key: objectKey,
    size_bytes: 4,
    mime_type: 'text/plain',
    created_at: '2030-01-01T00:00:00.000Z',
    updated_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    storage_status: 'deleting',
    purged_at: null,
    ...overrides,
  }
}

export function makeTrashRepository(initial: FileRecord[] = []) {
  const records: FileRecord[] = initial.map((record) => ({ ...record }))

  function toItem(record: FileRecord): TrashItem {
    const parent = record.parent_id === null
      ? null
      : records.find((candidate) => candidate.id === record.parent_id && candidate.kind === 'directory')
    return {
      id: record.id,
      owner_id: record.owner_id,
      parent_id: record.parent_id,
      kind: record.kind,
      name: record.name,
      name_key: record.name_key,
      object_key: record.object_key,
      size_bytes: record.size_bytes,
      mime_type: record.mime_type,
      created_at: record.created_at,
      updated_at: record.updated_at,
      deleted_at: record.deleted_at!,
      storage_account_id: record.storage_account_id ?? null,
      parent_name: parent?.name ?? null,
      item_count: record.kind === 'directory'
        ? records.filter((candidate) => candidate.owner_id === record.owner_id
          && candidate.deleted_at === record.deleted_at
          && candidate.id !== record.id).length
        : null,
    }
  }

  function isTrashed(record: FileRecord, ownerId: string, cutoff: string) {
    return record.owner_id === ownerId
      && record.deleted_at !== null
      && (record.purged_at === null || record.purged_at === undefined)
      && record.deleted_at > cutoff
  }

  function topLevel(record: FileRecord) {
    if (record.parent_id === null) return true
    const parent = records.find((candidate) => candidate.id === record.parent_id && candidate.owner_id === record.owner_id)
    if (!parent) return true
    return parent.deleted_at === null || parent.deleted_at !== record.deleted_at
  }

  const repository: TrashRepository & TrashTreeRepository = {
    async listTrash(ownerId, cutoff) {
      return records
        .filter((record) => isTrashed(record, ownerId, cutoff) && topLevel(record))
        .sort((a, b) => (a.deleted_at! < b.deleted_at! ? 1 : -1))
        .slice(0, 500)
        .map(toItem)
    },
    async findTrashFile(ownerId, id, cutoff) {
      const record = records.find((candidate) => candidate.id === id && isTrashed(candidate, ownerId, cutoff))
      return record ? toItem(record) : null
    },
    async hasActiveNameConflict(ownerId, parentId, nameKey) {
      return records.some(
        (record) => record.owner_id === ownerId
          && (record.parent_id ?? '') === (parentId ?? '')
          && record.name_key === nameKey
          && record.deleted_at === null,
      )
    },
    async restoreFile(ownerId, id, updatedAt) {
      const record = records.find(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'file'
          && candidate.deleted_at !== null
          && (candidate.purged_at === null || candidate.purged_at === undefined),
      )
      if (!record) return null
      const clash = records.some(
        (candidate) => candidate.id !== id
          && candidate.owner_id === ownerId
          && (candidate.parent_id ?? '') === (record.parent_id ?? '')
          && candidate.name_key === record.name_key
          && candidate.deleted_at === null,
      )
      if (clash) throw new FileRepositoryConflictError()
      record.deleted_at = null
      record.storage_status = 'ready'
      record.updated_at = updatedAt
      return record
    },
    async findActiveDirectory(ownerId, id) {
      const record = records.find(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'directory'
          && candidate.deleted_at === null,
      )
      return record ? { id: record.id } : null
    },
    async restoreFolderTree(ownerId, id, deletedAt, targetParentId, updatedAt) {
      const folder = records.find(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'directory'
          && candidate.deleted_at === deletedAt,
      )
      if (!folder) return null
      for (const record of records) {
        if (record.owner_id !== ownerId || record.deleted_at !== deletedAt) continue
        if (record.kind === 'file' && record.storage_status === 'deleting') continue
        record.deleted_at = null
        record.updated_at = updatedAt
      }
      folder.parent_id = targetParentId
      return folder
    },
    async deleteTrashedFile(ownerId, id) {
      const index = records.findIndex(
        (candidate) => candidate.id === id
          && candidate.owner_id === ownerId
          && candidate.kind === 'file'
          && candidate.deleted_at !== null,
      )
      if (index >= 0) records.splice(index, 1)
    },
    async deleteTrashedBatch(ownerId, deletedAt) {
      for (const record of records) {
        if (record.owner_id !== ownerId || record.deleted_at === deletedAt) continue
        const parent = records.find(
          (candidate) => candidate.owner_id === ownerId
            && candidate.deleted_at === deletedAt
            && candidate.id === record.parent_id,
        )
        if (parent) record.parent_id = null
      }
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record.owner_id === ownerId && record.deleted_at === deletedAt) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
    async deleteExpiredTrash(ownerId, cutoff) {
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        const live = record.kind === 'file' && record.object_key !== null && record.storage_status !== 'deleting'
        if (record.owner_id === ownerId && record.deleted_at !== null && record.deleted_at <= cutoff && !live) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
    async listExpiredLiveObjectKeys(ownerId, cutoff, limit) {
      return records
        .filter((record) => record.owner_id === ownerId
          && record.kind === 'file'
          && record.deleted_at !== null
          && record.deleted_at <= cutoff
          && record.storage_status !== 'deleting'
          && record.object_key !== null)
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key!, storage_account_id: record.storage_account_id ?? null }))
    },
    async listTrashObjectKeys(ownerId, cutoff, limit) {
      return records
        .filter((record) => isTrashed(record, ownerId, cutoff) && record.kind === 'file')
        .sort((a, b) => (a.deleted_at! < b.deleted_at! ? -1 : 1))
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key, storage_account_id: record.storage_account_id ?? null }))
    },
    async countTrash(ownerId, cutoff) {
      return records.filter((record) => isTrashed(record, ownerId, cutoff) && record.kind === 'file').length
    },
    async listBatchObjectKeys(ownerId, deletedAt, limit) {
      return records
        .filter((record) => record.owner_id === ownerId
          && record.kind === 'file'
          && record.deleted_at === deletedAt
          && (record.purged_at === null || record.purged_at === undefined))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((record) => ({ id: record.id, object_key: record.object_key, storage_account_id: record.storage_account_id ?? null }))
    },
    async countBatchFiles(ownerId, deletedAt) {
      return records.filter((record) => record.owner_id === ownerId
        && record.kind === 'file'
        && record.deleted_at === deletedAt
        && (record.purged_at === null || record.purged_at === undefined)).length
    },
    async purgeEmptyTrashFolders(ownerId, cutoff) {
      const emptyBatches = new Set(
        records
          .filter((record) => record.owner_id === ownerId
            && record.kind === 'directory'
            && record.deleted_at !== null
            && (record.purged_at === null || record.purged_at === undefined)
            && record.deleted_at > cutoff)
          .filter((directory) => !records.some(
            (candidate) => candidate.owner_id === ownerId
              && candidate.kind === 'file'
              && candidate.deleted_at === directory.deleted_at
              && (candidate.purged_at === null || candidate.purged_at === undefined),
          ))
          .map((directory) => directory.deleted_at!),
      )
      for (const record of records) {
        if (record.owner_id !== ownerId || record.parent_id === null) continue
        const parent = records.find((candidate) => candidate.owner_id === ownerId && candidate.id === record.parent_id)
        if (parent && parent.deleted_at !== null && emptyBatches.has(parent.deleted_at)) record.parent_id = null
      }
      let removed = 0
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record.owner_id === ownerId && record.deleted_at !== null && emptyBatches.has(record.deleted_at)) {
          records.splice(index, 1)
          removed += 1
        }
      }
      return removed
    },
  }
  return { repository, records }
}

export function makeDriveClient() {
  const untrashed: string[] = []
  const deletedPermanently: string[] = []
  const reTrashed: string[] = []
  const deleteErrors = new Map<string, BlobStoreError>()
  const untrashError = { current: null as BlobStoreError | null }
  const client: TrashDriveClient = {
    async untrash(id) {
      if (untrashError.current) throw untrashError.current
      untrashed.push(id)
    },
    async deletePermanently(id) {
      const error = deleteErrors.get(id)
      if (error) throw error
      deletedPermanently.push(id)
    },
    async trash(id) {
      reTrashed.push(id)
    },
  }
  return { client, untrashed, deletedPermanently, reTrashed, deleteErrors, untrashError }
}

export function buildOverrides(options: {
  records?: FileRecord[]
  user?: typeof owner
  authenticated?: boolean
} = {}) {
  const { repository, records } = makeTrashRepository(options.records ?? [])
  const drive = makeDriveClient()
  const overrides: Partial<TrashDependencies> = {
    createAuthRepository: () => authRepository(options.user, options.authenticated),
    createTrashRepository: () => repository,
    createStorageRepository: () => storageRepository(),
    createDriveClient: () => drive.client,
    fetchImpl: async () => new Response(null, { status: 500 }),
    now: () => now,
  }
  return { overrides, records, repository, ...drive }
}

export function run(handler: PagesFunction<AuthEnv>, request: Request, params: Record<string, string> = {}) {
  return handler({ request, env: env(), params } as never)
}

export function listRequest() {
  return new Request('https://cloudhub.test/api/trash', { headers: { Cookie: sessionCookie } })
}

export function clearRequest(origin = 'https://cloudhub.test') {
  return new Request('https://cloudhub.test/api/trash', {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: sessionCookie },
  })
}

export function purgeRequest(id = fileId, origin = 'https://cloudhub.test') {
  return new Request(`https://cloudhub.test/api/trash/${id}`, {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: sessionCookie },
  })
}

export function restoreRequest(id = fileId, origin = 'https://cloudhub.test') {
  return new Request(`https://cloudhub.test/api/trash/${id}/restore`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: sessionCookie },
  })
}

export function trashed(overrides: Partial<FileRecord> = {}) {
  return fileRecord({ deleted_at: '2030-01-10T00:00:00.000Z', ...overrides })
}

export function trashedFolder(overrides: Partial<FileRecord> = {}) {
  return fileRecord({
    id: crypto.randomUUID(),
    kind: 'directory',
    object_key: null,
    size_bytes: null,
    mime_type: null,
    storage_status: 'ready',
    deleted_at: '2030-01-10T00:00:00.000Z',
    ...overrides,
  })
}
