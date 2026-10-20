PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 310000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  username_key TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  PRIMARY KEY (username_key, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked_until
  ON login_attempts(blocked_until);
