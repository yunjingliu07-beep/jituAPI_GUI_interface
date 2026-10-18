CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, settings TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX conversations_user ON conversations(user_id,updated_at);
ALTER TABLE tasks ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
ALTER TABLE tasks ADD COLUMN ui_settings TEXT;
CREATE INDEX tasks_conversation ON tasks(conversation_id,created_at);
