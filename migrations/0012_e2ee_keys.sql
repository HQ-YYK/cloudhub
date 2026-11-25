ALTER TABLE users ADD COLUMN kdf_salt TEXT;
ALTER TABLE users ADD COLUMN kdf_iterations INTEGER;
ALTER TABLE users ADD COLUMN wrapped_master_key TEXT;
ALTER TABLE users ADD COLUMN recovery_wrapped_key TEXT;
ALTER TABLE users ADD COLUMN keys_updated_at TEXT;
