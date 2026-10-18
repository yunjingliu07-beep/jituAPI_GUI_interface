ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN deleted_at INTEGER;
ALTER TABLE users ADD COLUMN onboarding_completed_at INTEGER;
ALTER TABLE users ADD COLUMN selected_api_id TEXT;
CREATE TABLE api_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, encrypted_key TEXT NOT NULL, key_hash TEXT NOT NULL, key_hint TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,key_hash));
CREATE INDEX api_profiles_user ON api_profiles(user_id,created_at);
ALTER TABLE tasks ADD COLUMN api_profile_id TEXT;
ALTER TABLE tasks ADD COLUMN api_key_hash TEXT;
