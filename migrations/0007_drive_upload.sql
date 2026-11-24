ALTER TABLE users ADD COLUMN drive_folder_id TEXT;
ALTER TABLE files ADD COLUMN drive_folder_id TEXT;
ALTER TABLE files ADD COLUMN md5 TEXT;

CREATE TABLE upload_sessions (
  file_id TEXT PRIMARY KEY NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_uri_ciphertext TEXT NOT NULL,
  session_uri_iv TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_upload_sessions_owner ON upload_sessions(owner_id);
