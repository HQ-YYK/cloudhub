ALTER TABLE files ADD COLUMN storage_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (storage_status IN ('pending', 'ready', 'failed', 'deleting'));

DROP INDEX IF EXISTS idx_files_active_name;

CREATE UNIQUE INDEX idx_files_active_name
  ON files(owner_id, COALESCE(parent_id, ''), name_key)
  WHERE deleted_at IS NULL
    AND (kind = 'directory' OR storage_status IN ('pending', 'ready', 'deleting'));
