ALTER TABLE messages ADD COLUMN execution_host TEXT CHECK(execution_host IN ('cloud', 'device'));
ALTER TABLE messages ADD COLUMN device_id TEXT;
ALTER TABLE messages ADD COLUMN model TEXT;
ALTER TABLE messages ADD COLUMN private INTEGER NOT NULL DEFAULT 0;

CREATE INDEX messages_device_created ON messages(device_id, created_at) WHERE device_id IS NOT NULL;
