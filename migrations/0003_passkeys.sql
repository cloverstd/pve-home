ALTER TABLE users ADD COLUMN enrollment_hash TEXT;

ALTER TABLE users ADD COLUMN enrollment_expires_at INTEGER;

CREATE UNIQUE INDEX users_enrollment ON users (enrollment_hash) WHERE enrollment_hash IS NOT NULL;

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0)
);

CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  enrollment_hash TEXT,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);

CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX user_sessions_user ON user_sessions (user_id);

CREATE INDEX user_sessions_expires ON user_sessions (expires_at);

CREATE TRIGGER revoke_disabled_user_sessions
AFTER UPDATE OF enabled ON users
WHEN NEW.enabled = 0
BEGIN
  DELETE FROM user_sessions WHERE user_id = NEW.id;
  DELETE FROM auth_challenges WHERE user_id = NEW.id;
END;
