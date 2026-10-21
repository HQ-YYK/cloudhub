export type FileStorageStatus = 'pending' | 'ready' | 'failed' | 'deleting'

const transitions: Record<FileStorageStatus, readonly FileStorageStatus[]> = {
  pending: ['ready', 'failed', 'deleting'],
  ready: ['deleting'],
  failed: ['pending', 'deleting'],
  deleting: ['failed'],
}

export class FileStorageStateError extends Error {
  readonly from: FileStorageStatus
  readonly to: FileStorageStatus

  constructor(from: FileStorageStatus, to: FileStorageStatus) {
    super(`invalid_file_storage_transition:${from}:${to}`)
    this.name = 'FileStorageStateError'
    this.from = from
    this.to = to
  }
}

export function assertFileStorageTransition(from: FileStorageStatus, to: FileStorageStatus) {
  if (!transitions[from].includes(to)) throw new FileStorageStateError(from, to)
}
