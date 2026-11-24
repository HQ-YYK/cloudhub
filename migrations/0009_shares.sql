CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  expires_at TEXT,            -- NULL means never
  revoked_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id, owner_id) REFERENCES files(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX idx_shares_owner ON shares(owner_id, created_at);
CREATE INDEX idx_shares_file ON shares(file_id);
