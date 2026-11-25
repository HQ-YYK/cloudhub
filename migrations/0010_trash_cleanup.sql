-- Permanently deleted and expired trash rows are no longer kept.
-- Shares and upload sessions are removed through ON DELETE CASCADE.
DELETE FROM files
WHERE kind = 'file'
  AND deleted_at IS NOT NULL
  AND (purged_at IS NOT NULL OR deleted_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'));
