-- Rebuild files to relax the name length CHECK and add E2EE columns.
-- D1's recommended rebuild pattern: defer foreign keys so shares and
-- upload_sessions survive the DROP/rename while still referencing files.
PRAGMA defer_foreign_keys = true;

CREATE TABLE files_new (
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
  storage_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (storage_status IN ('pending', 'ready', 'failed', 'deleting')),
  drive_folder_id TEXT,
  md5 TEXT,
  purged_at TEXT,
  storage_account_id INTEGER REFERENCES storage_accounts(id),
  enc INTEGER NOT NULL DEFAULT 0 CHECK (enc IN (0, 1)),
  wrapped_key TEXT,
  UNIQUE (id, owner_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id, owner_id) REFERENCES files(id, owner_id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'directory' AND object_key IS NULL AND size_bytes IS NULL AND mime_type IS NULL)
    OR kind = 'file'
  ),
  CHECK (length(name) > 0 AND length(name) <= 4096),
  CHECK (length(name_key) > 0),
  CHECK (enc = 0 OR kind = 'directory' OR wrapped_key IS NOT NULL)
);

INSERT INTO files_new (
  id, owner_id, parent_id, kind, name, name_key, object_key, size_bytes,
  mime_type, created_at, updated_at, deleted_at, storage_status,
  drive_folder_id, md5, purged_at, storage_account_id, enc, wrapped_key
)
SELECT
  id, owner_id, parent_id, kind, name, name_key, object_key, size_bytes,
  mime_type, created_at, updated_at, deleted_at, storage_status,
  drive_folder_id, md5, purged_at, storage_account_id, 0, NULL
FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE INDEX idx_files_owner_parent
  ON files(owner_id, parent_id);

CREATE INDEX idx_files_owner_updated
  ON files(owner_id, updated_at);

CREATE INDEX idx_files_object_key
  ON files(object_key);

CREATE UNIQUE INDEX idx_files_active_name
  ON files(owner_id, COALESCE(parent_id, ''), name_key)
  WHERE deleted_at IS NULL
    AND (kind = 'directory' OR storage_status IN ('pending', 'ready', 'deleting'));

CREATE INDEX idx_files_trash
  ON files(owner_id, deleted_at)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

CREATE INDEX idx_files_storage_account
  ON files(storage_account_id);

PRAGMA defer_foreign_keys = false;
