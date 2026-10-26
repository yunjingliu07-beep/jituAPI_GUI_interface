ALTER TABLE tasks ADD COLUMN result_files TEXT;
ALTER TABLE tasks ADD COLUMN result_count INTEGER;
ALTER TABLE tasks ADD COLUMN results_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN result_error TEXT;
CREATE INDEX tasks_result_sync ON tasks(results_ready,status,updated_at);
