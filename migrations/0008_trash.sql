ALTER TABLE files ADD COLUMN purged_at TEXT;

CREATE INDEX idx_files_trash
  ON files(owner_id, deleted_at)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
