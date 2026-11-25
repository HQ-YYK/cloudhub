ALTER TABLE users ADD COLUMN totp_secret_ciphertext TEXT;
ALTER TABLE users ADD COLUMN totp_secret_iv TEXT;
ALTER TABLE users ADD COLUMN totp_pending_ciphertext TEXT;
ALTER TABLE users ADD COLUMN totp_pending_iv TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

CREATE TABLE totp_recovery_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_totp_recovery_codes_user ON totp_recovery_codes(user_id);

CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_login_challenges_user ON login_challenges(user_id);
CREATE INDEX idx_login_challenges_expires_at ON login_challenges(expires_at);
