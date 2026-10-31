-- Upgrade existing accounts without reducing larger quotas or changing notices.
INSERT INTO account_storage(user_id,limit_bytes)
 SELECT id,3000000000 FROM users WHERE true
 ON CONFLICT(user_id) DO UPDATE SET limit_bytes=excluded.limit_bytes
 WHERE account_storage.limit_bytes<excluded.limit_bytes;

-- The self-hosted migrator also needs a durable marker for data-only migrations.
CREATE TABLE IF NOT EXISTS app_data_migrations (name TEXT PRIMARY KEY NOT NULL);
INSERT INTO app_data_migrations(name) VALUES('0009_storage_quota_3gb')
 ON CONFLICT(name) DO NOTHING;
