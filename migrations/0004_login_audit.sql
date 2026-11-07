ALTER TABLE audit ADD COLUMN ip TEXT;

ALTER TABLE audit ADD COLUMN user_agent TEXT;

ALTER TABLE audit ADD COLUMN access_token_hash TEXT;

CREATE UNIQUE INDEX audit_access_token_hash ON audit (access_token_hash) WHERE access_token_hash IS NOT NULL;
