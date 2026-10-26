ALTER TABLE account_storage ADD COLUMN limit_bytes INTEGER NOT NULL DEFAULT 1000000000 CHECK(limit_bytes>0);
INSERT INTO account_storage(user_id,limit_bytes)
 SELECT id,5000000000 FROM users WHERE lower(email)='ronnnlau@gmail.com'
 ON CONFLICT(user_id) DO UPDATE SET limit_bytes=excluded.limit_bytes;
CREATE INDEX tasks_timeout ON tasks(created_at,user_id) WHERE status IN ('submitting','unknown','queued','running');
