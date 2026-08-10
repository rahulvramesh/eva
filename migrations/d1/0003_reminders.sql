PRAGMA foreign_keys = ON;

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  run_at TEXT NOT NULL,
  next_run_at TEXT,
  timezone TEXT NOT NULL,
  recurrence TEXT NOT NULL CHECK(recurrence IN ('none', 'daily', 'weekly', 'monthly')),
  app_enabled INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT
);
CREATE INDEX reminders_user_next_run ON reminders(user_id, status, next_run_at);

CREATE TABLE reminder_runs (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
  app_status TEXT NOT NULL DEFAULT 'pending' CHECK(app_status IN ('pending', 'sent', 'skipped', 'failed')),
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK(email_status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(reminder_id, scheduled_for)
);
CREATE INDEX reminder_runs_user_created ON reminder_runs(user_id, created_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES reminder_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user_created ON notifications(user_id, created_at DESC);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  app_enabled INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
