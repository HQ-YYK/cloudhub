export interface ShareRecord {
  id: string
  owner_id: string
  file_id: string
  token_hash: string
  token_ciphertext: string
  token_iv: string
  expires_at: string | null
  revoked_at: string | null
  download_count: number
  created_at: string
}

export interface ShareWithFileRecord extends ShareRecord {
  file_name: string
  file_size_bytes: number | null
  file_mime_type: string | null
  file_object_key: string | null
  file_deleted_at: string | null
  file_storage_status: string
  file_kind: string
  file_storage_account_id: number | null
  file_enc: number
  file_wrapped_key: string | null
}

export interface ShareFileInfo {
  id: string
  name: string
  size_bytes: number | null
  mime_type: string | null
  object_key: string | null
  deleted_at: string | null
  storage_status: string
  kind: string
  enc: number
  wrapped_key: string | null
}

export interface NewShare {
  id: string
  ownerId: string
  fileId: string
  tokenHash: string
  tokenCiphertext: string
  tokenIv: string
  expiresAt: string | null
  createdAt: string
}

export interface ShareRepository {
  create(input: NewShare): Promise<ShareRecord>
  findById(id: string, ownerId: string): Promise<ShareRecord | null>
  findActiveByTokenHash(tokenHash: string, now: string): Promise<ShareWithFileRecord | null>
  findFileForShare(ownerId: string, fileId: string): Promise<ShareFileInfo | null>
  listByFile(ownerId: string, fileId: string, limit: number): Promise<ShareWithFileRecord[]>
  listByOwner(ownerId: string, limit: number): Promise<ShareWithFileRecord[]>
  countActiveByFile(ownerId: string, fileId: string, now: string): Promise<number>
  revoke(id: string, ownerId: string, revokedAt: string): Promise<void>
  incrementDownloadCount(id: string): Promise<void>
}
