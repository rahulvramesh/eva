PRAGMA foreign_keys = ON;

CREATE TABLE background_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  source_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  routing TEXT NOT NULL CHECK(routing IN ('auto', 'cloud', 'device', 'private')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting_device', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  progress TEXT NOT NULL DEFAULT 'Queued',
  result TEXT,
  error TEXT,
  execution_host TEXT CHECK(execution_host IN ('cloud', 'device')),
  device_id TEXT,
  model TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX background_tasks_user_status_updated ON background_tasks(user_id, status, updated_at DESC);
CREATE INDEX background_tasks_user_retry ON background_tasks(user_id, status, retry_at);

CREATE TABLE task_notifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES background_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX task_notifications_user_created ON task_notifications(user_id, created_at DESC);
