CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -257)),
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  name TEXT NOT NULL,
  transports TEXT,
  prf_wrapped_master_key TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_webauthn_challenges_expires_at ON webauthn_challenges(expires_at);
