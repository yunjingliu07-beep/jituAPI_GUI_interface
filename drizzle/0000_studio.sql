CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, verified_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE email_codes (id TEXT PRIMARY KEY, email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX email_codes_lookup ON email_codes(email, purpose, created_at);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), upstream_id TEXT, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, mode TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL, size TEXT NOT NULL, count INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, charged REAL, balance REAL, UNIQUE(user_id,idempotency_key));
CREATE INDEX tasks_user ON tasks(user_id,created_at);
