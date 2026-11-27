export function isActiveNameConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed: index ['"]?idx_files_active_name['"]?/iu.test(message)
}

export function isIdConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed: files\.id\b/u.test(message)
    || /PRIMARY KEY constraint failed/u.test(message)
}
