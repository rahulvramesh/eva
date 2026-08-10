import type {
  BackgroundTask,
  BackgroundTaskStatus,
  EvaNotification,
  ExecutionHost,
  RoutingPolicy,
} from "../../../packages/protocol/src/index";

type TaskRow = {
  id: string;
  title: string;
  prompt: string;
  chat_id: string;
  source_chat_id: string | null;
  routing: RoutingPolicy;
  status: BackgroundTaskStatus;
  progress: string;
  result: string | null;
  error: string | null;
  execution_host: ExecutionHost | null;
  device_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type BackgroundTaskInput = {
  title: string;
  prompt: string;
  routing: RoutingPolicy;
  sourceChatId?: string;
};

export async function createBackgroundTask(db: D1Database, userId: string, input: BackgroundTaskInput): Promise<BackgroundTask> {
  const id = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = input.title.trim();
  await db.batch([
    db.prepare("INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
      .bind(chatId, userId, title, now),
    db.prepare(`
      INSERT INTO background_tasks
        (id, user_id, title, prompt, chat_id, source_chat_id, routing, status, progress, retry_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 'Queued', ?8, ?8, ?8)
    `).bind(id, userId, title, input.prompt.trim(), chatId, input.sourceChatId ?? null, input.routing, now),
  ]);
  return getBackgroundTask(db, userId, id);
}

export async function listBackgroundTasks(db: D1Database, userId: string): Promise<BackgroundTask[]> {
  const result = await db.prepare(`
    SELECT id, title, prompt, chat_id, source_chat_id, routing, status, progress, result, error,
      execution_host, device_id, model, created_at, updated_at, started_at, completed_at
    FROM background_tasks WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100
  `).bind(userId).all<TaskRow>();
  return result.results.map(toBackgroundTask);
}

export async function getBackgroundTask(db: D1Database, userId: string, taskId: string): Promise<BackgroundTask> {
  const row = await db.prepare(`
    SELECT id, title, prompt, chat_id, source_chat_id, routing, status, progress, result, error,
      execution_host, device_id, model, created_at, updated_at, started_at, completed_at
    FROM background_tasks WHERE id = ?1 AND user_id = ?2
  `).bind(taskId, userId).first<TaskRow>();
  if (!row) throw new Error("Background task not found.");
  return toBackgroundTask(row);
}

export async function getRunnableBackgroundTask(db: D1Database, userId: string): Promise<BackgroundTask | undefined> {
  const row = await db.prepare(`
    SELECT id, title, prompt, chat_id, source_chat_id, routing, status, progress, result, error,
      execution_host, device_id, model, created_at, updated_at, started_at, completed_at
    FROM background_tasks
    WHERE user_id = ?1 AND status IN ('queued', 'waiting_device')
      AND (retry_at IS NULL OR retry_at <= ?2)
    ORDER BY created_at LIMIT 1
  `).bind(userId, new Date().toISOString()).first<TaskRow>();
  return row ? toBackgroundTask(row) : undefined;
}

export async function nextBackgroundTaskTime(db: D1Database, userId: string): Promise<number | null> {
  const row = await db.prepare(`
    SELECT COALESCE(retry_at, created_at) AS due_at FROM background_tasks
    WHERE user_id = ?1 AND status IN ('queued', 'waiting_device')
    ORDER BY COALESCE(retry_at, created_at) LIMIT 1
  `).bind(userId).first<{ due_at: string }>();
  return row ? Date.parse(row.due_at) : null;
}

export async function updateBackgroundTask(
  db: D1Database,
  userId: string,
  taskId: string,
  patch: {
    status: BackgroundTaskStatus;
    progress: string;
    result?: string;
    error?: string;
    executionHost?: ExecutionHost;
    deviceId?: string;
    model?: string;
    retryAt?: string;
  },
): Promise<BackgroundTask> {
  const now = new Date().toISOString();
  const terminal = ["completed", "failed", "cancelled"].includes(patch.status);
  const result = await db.prepare(`
    UPDATE background_tasks SET status = ?1, progress = ?2, result = ?3, error = ?4,
      execution_host = COALESCE(?5, execution_host), device_id = COALESCE(?6, device_id),
      model = COALESCE(?7, model), retry_at = ?8, updated_at = ?9,
      started_at = CASE WHEN ?1 = 'running' THEN COALESCE(started_at, ?9) ELSE started_at END,
      completed_at = CASE WHEN ?10 = 1 THEN COALESCE(completed_at, ?9) ELSE NULL END
    WHERE id = ?11 AND user_id = ?12 AND status NOT IN ('completed', 'failed', 'cancelled')
  `).bind(
    patch.status,
    patch.progress,
    patch.result ?? null,
    patch.error ?? null,
    patch.executionHost ?? null,
    patch.deviceId ?? null,
    patch.model ?? null,
    patch.retryAt ?? null,
    now,
    terminal ? 1 : 0,
    taskId,
    userId,
  ).run();
  if (!result.meta.changes) return getBackgroundTask(db, userId, taskId);
  return getBackgroundTask(db, userId, taskId);
}

export async function findBackgroundTaskByChat(db: D1Database, userId: string, chatId: string): Promise<BackgroundTask | undefined> {
  const row = await db.prepare(`
    SELECT id, title, prompt, chat_id, source_chat_id, routing, status, progress, result, error,
      execution_host, device_id, model, created_at, updated_at, started_at, completed_at
    FROM background_tasks WHERE user_id = ?1 AND chat_id = ?2
  `).bind(userId, chatId).first<TaskRow>();
  return row ? toBackgroundTask(row) : undefined;
}

export async function hasPendingApproval(db: D1Database, userId: string, chatId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present FROM pending_approvals
    WHERE user_id = ?1 AND chat_id = ?2 AND status = 'pending' LIMIT 1
  `).bind(userId, chatId).first<{ present: number }>();
  return Boolean(row);
}

export async function createTaskNotification(db: D1Database, userId: string, task: BackgroundTask): Promise<EvaNotification> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const title = task.status === "completed" ? `Completed: ${task.title}` : `Task failed: ${task.title}`;
  const body = task.status === "completed" ? task.result || "Eva finished this background task." : task.error || "Eva could not finish this background task.";
  await db.prepare(`
    INSERT INTO task_notifications (id, task_id, user_id, title, body, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(task_id) DO NOTHING
  `).bind(id, task.id, userId, title, body.slice(0, 2_000), createdAt).run();
  const row = await db.prepare(`
    SELECT id, task_id, title, body, created_at, read_at FROM task_notifications WHERE task_id = ?1
  `).bind(task.id).first<{ id: string; task_id: string; title: string; body: string; created_at: string; read_at: string | null }>();
  if (!row) throw new Error("Could not persist the task notification.");
  return { id: row.id, taskId: row.task_id, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at ?? undefined };
}

function toBackgroundTask(row: TaskRow): BackgroundTask {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    chatId: row.chat_id,
    sourceChatId: row.source_chat_id ?? undefined,
    routing: row.routing,
    status: row.status,
    progress: row.progress,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    executionHost: row.execution_host ?? undefined,
    deviceId: row.device_id ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}
