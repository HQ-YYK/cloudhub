PRAGMA defer_foreign_keys = true;
PRAGMA foreign_keys = ON;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 100000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

INSERT INTO users_new (
  id,
  username,
  password_hash,
  password_salt,
  password_iterations,
  created_at,
  updated_at,
  disabled
)
SELECT
  id,
  username,
  password_hash,
  password_salt,
  password_iterations,
  created_at,
  updated_at,
  disabled
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked_until
  ON login_attempts(blocked_until);
