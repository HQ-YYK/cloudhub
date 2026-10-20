CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  object_key TEXT,
  size_bytes INTEGER,
  mime_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (id, owner_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id, owner_id) REFERENCES files(id, owner_id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'directory' AND object_key IS NULL AND size_bytes IS NULL AND mime_type IS NULL)
    OR kind = 'file'
  ),
  CHECK (length(name) > 0 AND length(name) <= 255),
  CHECK (length(name_key) > 0)
);

CREATE INDEX IF NOT EXISTS idx_files_owner_parent
  ON files(owner_id, parent_id);

CREATE INDEX IF NOT EXISTS idx_files_owner_updated
  ON files(owner_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_files_object_key
  ON files(object_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_active_name
  ON files(owner_id, COALESCE(parent_id, ''), name_key)
  WHERE deleted_at IS NULL;
