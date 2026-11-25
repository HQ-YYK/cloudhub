CREATE TABLE storage_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  root_folder_id TEXT NOT NULL,
  connected_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'readonly', 'reauth')),
  quota_total INTEGER,
  quota_used INTEGER,
  quota_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO storage_accounts (
  id, google_email, refresh_token_ciphertext, refresh_token_iv,
  root_folder_id, connected_by, status, quota_total, quota_used, quota_checked_at,
  created_at, updated_at
)
SELECT
  id, google_email, refresh_token_ciphertext, refresh_token_iv,
  root_folder_id, connected_by, 'active', NULL, NULL, NULL,
  created_at, updated_at
FROM storage_account;

DROP TABLE storage_account;

CREATE TABLE storage_user_folders (
  account_id INTEGER NOT NULL REFERENCES storage_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

INSERT INTO storage_user_folders (account_id, user_id, folder_id)
SELECT 1, id, drive_folder_id
FROM users
WHERE drive_folder_id IS NOT NULL;

ALTER TABLE files ADD COLUMN storage_account_id INTEGER REFERENCES storage_accounts(id);

UPDATE files SET storage_account_id = 1 WHERE object_key IS NOT NULL;

CREATE INDEX idx_files_storage_account ON files(storage_account_id);
