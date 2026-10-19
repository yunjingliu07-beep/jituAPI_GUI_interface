CREATE TABLE api_activity (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  responded_at INTEGER,
  source TEXT NOT NULL CHECK(source IN ('live','historical')),
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  requested_count INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pending','accepted','rejected','unknown','historical')),
  http_status INTEGER,
  task_status TEXT NOT NULL,
  upstream_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX api_activity_time ON api_activity(started_at DESC,id DESC);
CREATE INDEX api_activity_user_time ON api_activity(user_id,started_at DESC);
CREATE INDEX api_activity_task ON api_activity(task_id);

-- Hosted D1 schema only. The immutable Ubuntu migration retains its historical backfill.
-- No foreign key to tasks: deleting a chat must not erase operational records.
CREATE TRIGGER api_activity_task_update AFTER UPDATE OF status,upstream_id ON tasks
BEGIN
  UPDATE api_activity SET task_status=NEW.status,
    upstream_id=COALESCE(NEW.upstream_id,upstream_id),updated_at=NEW.updated_at
  WHERE task_id=NEW.id;
END;
