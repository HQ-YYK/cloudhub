-- Local/manual initialization template.
-- Replace every placeholder with values generated locally by the documented
-- password-hash script. Never commit real passwords or generated secrets.
INSERT INTO users (
  id,
  username,
  password_hash,
  password_salt,
  password_iterations,
  created_at,
  updated_at,
  disabled
) VALUES
  (
    'replace-with-user-1-id',
    'replace-with-user-1-name',
    'replace-with-user-1-password-hash',
    'replace-with-user-1-password-salt',
    310000,
    'replace-with-utc-timestamp',
    'replace-with-utc-timestamp',
    0
  ),
  (
    'replace-with-user-2-id',
    'replace-with-user-2-name',
    'replace-with-user-2-password-hash',
    'replace-with-user-2-password-salt',
    310000,
    'replace-with-utc-timestamp',
    'replace-with-utc-timestamp',
    0
  );
