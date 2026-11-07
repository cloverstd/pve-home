CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('qemu', 'lxc')),
  vmid INTEGER NOT NULL,
  node TEXT NOT NULL,
  name TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  UNIQUE (kind, vmid)
);

CREATE TABLE grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  can_start INTEGER NOT NULL CHECK (can_start IN (0, 1)),
  can_shutdown INTEGER NOT NULL CHECK (can_shutdown IN (0, 1)),
  can_force_stop INTEGER NOT NULL CHECK (can_force_stop IN (0, 1)),
  PRIMARY KEY (user_id, machine_id)
);

CREATE TRIGGER revoke_missing_machine_grants
AFTER UPDATE OF available ON machines
WHEN OLD.available = 1 AND NEW.available = 0
BEGIN
  DELETE FROM grants WHERE machine_id = NEW.id;
END;

CREATE TABLE operations (
  id TEXT PRIMARY KEY NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start', 'shutdown', 'force_stop')),
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitting', 'running', 'succeeded', 'failed', 'unknown', 'resolved')),
  node TEXT NOT NULL,
  upid TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checked_at INTEGER,
  last_reachable_at INTEGER,
  resolved_by TEXT,
  UNIQUE (actor_id, idempotency_key)
);

CREATE UNIQUE INDEX one_active_operation_per_machine
ON operations (machine_id)
WHERE state IN ('submitting', 'running', 'unknown');

CREATE INDEX operations_recent ON operations (created_at DESC, id DESC);
CREATE INDEX operations_poll ON operations (state, checked_at, created_at);
CREATE INDEX operations_actor ON operations (actor_id, created_at DESC);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL
);

CREATE TRIGGER audit_operation_submitted
AFTER INSERT ON operations
BEGIN
  INSERT INTO audit (at, actor_email, action, target, result)
  VALUES (NEW.created_at, NEW.actor_email, NEW.action, NEW.machine_id, NEW.state);
END;

CREATE TRIGGER audit_operation_result
AFTER UPDATE OF state ON operations
WHEN OLD.state <> NEW.state
BEGIN
  INSERT INTO audit (at, actor_email, action, target, result)
  VALUES (NEW.updated_at, COALESCE(NEW.resolved_by, NEW.actor_email),
    CASE WHEN NEW.state = 'resolved' THEN 'resolve_operation' ELSE NEW.action END,
    NEW.machine_id, NEW.state);
END;
