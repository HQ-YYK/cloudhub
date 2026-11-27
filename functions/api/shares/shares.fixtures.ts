import type { D1Database } from '@cloudflare/workers-types'
import type { AuthRepository } from '../../_lib/auth-repository.ts'
import type { AuthEnv } from '../../_lib/cloudflare-env.ts'
import type {
  NewShare,
  ShareFileInfo,
  ShareRecord,
  ShareRepository,
  ShareWithFileRecord,
} from '../../_lib/share-repository.ts'

export const owner = { id: 'owner-1', username: 'alice', role: 'user' as const, must_change_password: 0 }
export const otherOwner = { id: 'owner-2', username: 'bob', role: 'user' as const, must_change_password: 0 }
export const encryptionKey = Buffer.from('1'.repeat(32), 'ascii').toString('base64url')
export const fileId = 'file-1'

interface StoredFile extends ShareFileInfo {
  owner_id: string
  storage_account_id: number | null
}

export function authRepository(user: typeof owner | null = owner): AuthRepository {
  return {
    findUser: async () => null,
    findSessionUser: async () => user
      ? { session_id: 'session', id: user.id, username: user.username, role: user.role, must_change_password: user.must_change_password }
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

export function shareFile(options: Partial<StoredFile> = {}): StoredFile {
  return {
    id: fileId,
    owner_id: owner.id,
    name: '报告.txt',
    size_bytes: 100,
    mime_type: 'text/plain',
    object_key: 'objects/file-1',
    deleted_at: null,
    storage_status: 'ready',
    kind: 'file',
    storage_account_id: null,
    enc: 0,
    wrapped_key: null,
    ...options,
  }
}

export function shareRecord(options: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'share-1',
    owner_id: owner.id,
    file_id: fileId,
    token_hash: '0'.repeat(64),
    token_ciphertext: 'cipher',
    token_iv: 'iv',
    expires_at: null,
    revoked_at: null,
    download_count: 0,
    created_at: '2030-01-01T00:00:00.000Z',
    ...options,
  }
}

function toShareWithFile(share: ShareRecord, file: StoredFile): ShareWithFileRecord {
  return {
    ...share,
    file_name: file.name,
    file_size_bytes: file.size_bytes,
    file_mime_type: file.mime_type,
    file_object_key: file.object_key,
    file_deleted_at: file.deleted_at,
    file_storage_status: file.storage_status,
    file_kind: file.kind,
    file_storage_account_id: file.storage_account_id ?? null,
    file_enc: file.enc,
    file_wrapped_key: file.wrapped_key,
  }
}

export function shareRepository(files: StoredFile[] = [], shares: ShareRecord[] = []) {
  const createdInputs: NewShare[] = []
  const incremented: string[] = []

  const repository: ShareRepository = {
    async create(input) {
      createdInputs.push(input)
      const record: ShareRecord = {
        id: input.id,
        owner_id: input.ownerId,
        file_id: input.fileId,
        token_hash: input.tokenHash,
        token_ciphertext: input.tokenCiphertext,
        token_iv: input.tokenIv,
        expires_at: input.expiresAt,
        revoked_at: null,
        download_count: 0,
        created_at: input.createdAt,
      }
      shares.push(record)
      return record
    },
    async findById(id, ownerIdValue) {
      return shares.find((share) => share.id === id && share.owner_id === ownerIdValue) ?? null
    },
    async findActiveByTokenHash(tokenHash, now) {
      const share = shares.find((candidate) => (
        candidate.token_hash === tokenHash
        && candidate.revoked_at === null
        && (candidate.expires_at === null || candidate.expires_at > now)
      ))
      if (!share) return null
      const file = files.find((candidate) => (
        candidate.id === share.file_id && candidate.owner_id === share.owner_id
      ))
      if (!file || file.deleted_at !== null || file.kind !== 'file' || file.storage_status !== 'ready') {
        return null
      }
      return toShareWithFile(share, file)
    },
    async findFileForShare(ownerIdValue, id) {
      const file = files.find((candidate) => candidate.id === id && candidate.owner_id === ownerIdValue)
      if (!file) return null
      return {
        id: file.id,
        name: file.name,
        size_bytes: file.size_bytes,
        mime_type: file.mime_type,
        object_key: file.object_key,
        deleted_at: file.deleted_at,
        storage_status: file.storage_status,
        kind: file.kind,
        enc: file.enc,
        wrapped_key: file.wrapped_key,
      }
    },
    async listByFile(ownerIdValue, id, limit) {
      return shares
        .filter((share) => share.owner_id === ownerIdValue && share.file_id === id)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((share) => toShareWithFile(
          share,
          files.find((file) => file.id === share.file_id && file.owner_id === share.owner_id)!,
        ))
    },
    async listByOwner(ownerIdValue, limit) {
      return shares
        .filter((share) => share.owner_id === ownerIdValue)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((share) => toShareWithFile(
          share,
          files.find((file) => file.id === share.file_id && file.owner_id === share.owner_id)!,
        ))
    },
    async countActiveByFile(ownerIdValue, id, now) {
      return shares.filter((share) => (
        share.owner_id === ownerIdValue
        && share.file_id === id
        && share.revoked_at === null
        && (share.expires_at === null || share.expires_at > now)
      )).length
    },
    async revoke(id, ownerIdValue, revokedAt) {
      const share = shares.find((candidate) => candidate.id === id && candidate.owner_id === ownerIdValue)
      if (share && share.revoked_at === null) share.revoked_at = revokedAt
    },
    async incrementDownloadCount(id) {
      incremented.push(id)
      const share = shares.find((candidate) => candidate.id === id)
      if (share) share.download_count += 1
    },
  }

  return { repository, files, shares, createdInputs, incremented }
}

export function request(url: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { Cookie: 'cloudhub_session=session', ...headers },
  })
}

export function handlerContext(
  onRequest: (context: never) => Promise<Response> | Response,
  req: Request,
  params: Record<string, string> = {},
) {
  const env = { DB: {} as D1Database, STORAGE_ENCRYPTION_KEY: encryptionKey } satisfies AuthEnv
  return onRequest({ request: req, env, params } as never)
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function makeToken(seed: number) {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function testToken() {
  return makeToken(1)
}

export async function readBody(response: Response) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
