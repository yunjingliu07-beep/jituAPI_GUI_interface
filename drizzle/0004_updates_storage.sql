ALTER TABLE users ADD COLUMN last_seen_release TEXT;
ALTER TABLE tasks ADD COLUMN references_ready INTEGER NOT NULL DEFAULT 1;
CREATE TABLE account_storage (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 notice_revision INTEGER NOT NULL DEFAULT 0,
 acknowledged_revision INTEGER NOT NULL DEFAULT 0,
 notice_conversations INTEGER NOT NULL DEFAULT 0,
 notice_tasks INTEGER NOT NULL DEFAULT 0,
 notice_at INTEGER
);
CREATE INDEX conversations_user_created ON conversations(user_id,created_at,id);
