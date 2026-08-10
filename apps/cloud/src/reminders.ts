import type {
  EvaNotification,
  NotificationPreferences,
  Reminder,
  ReminderRecurrence,
  ReminderStatus,
} from "../../../packages/protocol/src/index";

type ReminderRow = {
  id: string; title: string; notes: string; run_at: string; next_run_at: string | null;
  timezone: string; recurrence: ReminderRecurrence; app_enabled: number; email_enabled: number;
  status: ReminderStatus; created_at: string; updated_at: string; last_run_at: string | null;
};
type NotificationRow = {
  id: string; reminder_id: string | null; task_id?: string | null; title: string; body: string; created_at: string; read_at: string | null;
};
type RunRow = { id: string; app_status: string; email_status: string; attempts: number };

export type ReminderInput = {
  title: string;
  notes: string;
  runAt: string;
  timezone: string;
  recurrence: ReminderRecurrence;
  appEnabled: boolean;
  emailEnabled: boolean;
};

export async function listReminders(db: D1Database, userId: string): Promise<Reminder[]> {
  const result = await db.prepare(`
    SELECT id, title, notes, run_at, next_run_at, timezone, recurrence, app_enabled, email_enabled,
      status, created_at, updated_at, last_run_at
    FROM reminders WHERE user_id = ?1
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, next_run_at, updated_at DESC
  `).bind(userId).all<ReminderRow>();
  return result.results.map(toReminder);
}

export async function createReminder(db: D1Database, userId: string, input: ReminderInput): Promise<Reminder> {
  validateSchedule(input.runAt, input.timezone);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO reminders
      (id, user_id, title, notes, run_at, next_run_at, timezone, recurrence, app_enabled, email_enabled, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)
  `).bind(id, userId, input.title.trim(), input.notes.trim(), new Date(input.runAt).toISOString(), input.timezone,
    input.recurrence, input.appEnabled ? 1 : 0, input.emailEnabled ? 1 : 0, now).run();
  return getReminder(db, userId, id);
}

export async function updateReminder(
  db: D1Database,
  userId: string,
  input: ReminderInput & { id: string; status: ReminderStatus },
): Promise<Reminder> {
  validateTimeZone(input.timezone);
  if (input.status === "active") validateSchedule(input.runAt, input.timezone);
  const runAt = new Date(input.runAt).toISOString();
  const nextRunAt = input.status === "active" ? runAt : null;
  const result = await db.prepare(`
    UPDATE reminders SET title = ?1, notes = ?2, run_at = ?3, next_run_at = ?4, timezone = ?5,
      recurrence = ?6, app_enabled = ?7, email_enabled = ?8, status = ?9, updated_at = ?10
    WHERE id = ?11 AND user_id = ?12
  `).bind(input.title.trim(), input.notes.trim(), runAt, nextRunAt, input.timezone, input.recurrence,
    input.appEnabled ? 1 : 0, input.emailEnabled ? 1 : 0, input.status, new Date().toISOString(), input.id, userId).run();
  if (!result.meta.changes) throw new Error("Reminder not found.");
  return getReminder(db, userId, input.id);
}

export async function deleteReminder(db: D1Database, userId: string, reminderId: string): Promise<void> {
  const result = await db.prepare("DELETE FROM reminders WHERE id = ?1 AND user_id = ?2").bind(reminderId, userId).run();
  if (!result.meta.changes) throw new Error("Reminder not found.");
}

export async function nextReminderTime(db: D1Database, userId: string): Promise<number | null> {
  const row = await db.prepare(`
    SELECT next_run_at FROM reminders
    WHERE user_id = ?1 AND status = 'active' AND next_run_at IS NOT NULL
    ORDER BY next_run_at LIMIT 1
  `).bind(userId).first<{ next_run_at: string }>();
  return row ? Date.parse(row.next_run_at) : null;
}

export async function processDueReminders(
  env: Env,
  userId: string,
  notify: (notification: EvaNotification) => Promise<void>,
): Promise<void> {
  const due = await env.DB.prepare(`
    SELECT id, title, notes, run_at, next_run_at, timezone, recurrence, app_enabled, email_enabled,
      status, created_at, updated_at, last_run_at
    FROM reminders
    WHERE user_id = ?1 AND status = 'active' AND next_run_at <= ?2
    ORDER BY next_run_at LIMIT 50
  `).bind(userId, new Date().toISOString()).all<ReminderRow>();
  for (const row of due.results) await deliverReminder(env, userId, row, notify);
}

async function deliverReminder(
  env: Env,
  userId: string,
  row: ReminderRow,
  notify: (notification: EvaNotification) => Promise<void>,
): Promise<void> {
  const scheduledFor = row.next_run_at;
  if (!scheduledFor) return;
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO reminder_runs (id, reminder_id, user_id, scheduled_for, status, created_at)
    VALUES (?1, ?2, ?3, ?4, 'running', ?5)
    ON CONFLICT(reminder_id, scheduled_for) DO NOTHING
  `).bind(runId, row.id, userId, scheduledFor, now).run();
  let run = await env.DB.prepare(`
    SELECT id, app_status, email_status, attempts FROM reminder_runs
    WHERE reminder_id = ?1 AND scheduled_for = ?2
  `).bind(row.id, scheduledFor).first<RunRow>();
  if (!run || (run.app_status === "sent" || run.app_status === "skipped") && (run.email_status === "sent" || run.email_status === "skipped")) return;

  await env.DB.prepare("UPDATE reminder_runs SET attempts = attempts + 1, status = 'running' WHERE id = ?1").bind(run.id).run();
  const preferences = await getNotificationPreferences(env.DB, userId);
  const body = row.notes || `Scheduled for ${formatInZone(scheduledFor, row.timezone)}.`;
  const errors: string[] = [];

  if (run.app_status !== "sent" && run.app_status !== "skipped") {
    if (row.app_enabled && preferences.appEnabled) {
      try {
        const notification = await createRunNotification(env.DB, userId, run.id, row.id, row.title, body);
        await notify(notification);
        await setRunChannel(env.DB, run.id, "app_status", "sent");
      } catch (error) {
        errors.push(`App: ${errorMessage(error)}`);
        await setRunChannel(env.DB, run.id, "app_status", "failed");
      }
    } else await setRunChannel(env.DB, run.id, "app_status", "skipped");
  }

  if (run.email_status !== "sent" && run.email_status !== "skipped") {
    if (row.email_enabled && preferences.emailEnabled && preferences.email) {
      try {
        await env.EMAIL.send({
          to: preferences.email,
          from: { email: env.EVA_REMINDER_FROM, name: "Eva" },
          subject: `Reminder: ${row.title}`,
          text: `${row.title}\n\n${body}\n\nScheduled by Eva for ${formatInZone(scheduledFor, row.timezone)}.`,
          html: `<h2>${escapeHtml(row.title)}</h2><p>${escapeHtml(body)}</p><p style="color:#666">Scheduled by Eva for ${escapeHtml(formatInZone(scheduledFor, row.timezone))}.</p>`,
        });
        await setRunChannel(env.DB, run.id, "email_status", "sent");
      } catch (error) {
        errors.push(`Email: ${errorMessage(error)}`);
        await setRunChannel(env.DB, run.id, "email_status", "failed");
      }
    } else await setRunChannel(env.DB, run.id, "email_status", "skipped");
  }

  if (errors.length) {
    await env.DB.prepare("UPDATE reminder_runs SET status = 'failed', error = ?1 WHERE id = ?2").bind(errors.join("; "), run.id).run();
    throw new Error(errors.join("; "));
  }

  const next = nextOccurrence(scheduledFor, row.timezone, row.recurrence);
  await env.DB.batch([
    env.DB.prepare("UPDATE reminder_runs SET status = 'complete', completed_at = ?1, error = NULL WHERE id = ?2").bind(now, run.id),
    env.DB.prepare(`
      UPDATE reminders SET next_run_at = ?1, last_run_at = ?2,
        status = CASE WHEN ?1 IS NULL THEN 'completed' ELSE status END, updated_at = ?2
      WHERE id = ?3 AND user_id = ?4 AND next_run_at = ?5
    `).bind(next, now, row.id, userId, scheduledFor),
  ]);
}

export async function listNotifications(db: D1Database, userId: string): Promise<EvaNotification[]> {
  const result = await db.prepare(`
    SELECT id, reminder_id, NULL AS task_id, title, body, created_at, read_at FROM notifications WHERE user_id = ?1
    UNION ALL
    SELECT id, NULL AS reminder_id, task_id, title, body, created_at, read_at FROM task_notifications WHERE user_id = ?1
    ORDER BY created_at DESC LIMIT 100
  `).bind(userId).all<NotificationRow>();
  return result.results.map(toNotification);
}

export async function markNotificationRead(db: D1Database, userId: string, id: string): Promise<string> {
  const readAt = new Date().toISOString();
  const results = await db.batch([
    db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?1) WHERE id = ?2 AND user_id = ?3").bind(readAt, id, userId),
    db.prepare("UPDATE task_notifications SET read_at = COALESCE(read_at, ?1) WHERE id = ?2 AND user_id = ?3").bind(readAt, id, userId),
  ]);
  if (!results[0]?.meta.changes && !results[1]?.meta.changes) throw new Error("Notification not found.");
  return readAt;
}

export async function getNotificationPreferences(db: D1Database, userId: string): Promise<NotificationPreferences> {
  const row = await db.prepare("SELECT email, app_enabled, email_enabled, timezone FROM notification_preferences WHERE user_id = ?1")
    .bind(userId).first<{ email: string; app_enabled: number; email_enabled: number; timezone: string }>();
  const timezone = row?.timezone ?? "Asia/Jakarta";
  validateTimeZone(timezone);
  return { email: row?.email ?? "", appEnabled: row ? Boolean(row.app_enabled) : true, emailEnabled: Boolean(row?.email_enabled), timezone };
}

export async function updateNotificationPreferences(
  db: D1Database,
  userId: string,
  preferences: NotificationPreferences,
): Promise<NotificationPreferences> {
  if (preferences.emailEnabled && !preferences.email) throw new Error("Add an email address before enabling email reminders.");
  validateTimeZone(preferences.timezone);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO notification_preferences (user_id, email, app_enabled, email_enabled, timezone, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, app_enabled = excluded.app_enabled,
      email_enabled = excluded.email_enabled, timezone = excluded.timezone, updated_at = excluded.updated_at
  `).bind(userId, preferences.email.toLowerCase(), preferences.appEnabled ? 1 : 0, preferences.emailEnabled ? 1 : 0, preferences.timezone, now).run();
  return getNotificationPreferences(db, userId);
}

async function getReminder(db: D1Database, userId: string, id: string): Promise<Reminder> {
  const row = await db.prepare(`
    SELECT id, title, notes, run_at, next_run_at, timezone, recurrence, app_enabled, email_enabled,
      status, created_at, updated_at, last_run_at FROM reminders WHERE id = ?1 AND user_id = ?2
  `).bind(id, userId).first<ReminderRow>();
  if (!row) throw new Error("Reminder not found.");
  return toReminder(row);
}

async function createRunNotification(db: D1Database, userId: string, runId: string, reminderId: string, title: string, body: string): Promise<EvaNotification> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.prepare(`
    INSERT INTO notifications (id, run_id, user_id, reminder_id, title, body, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(run_id) DO NOTHING
  `).bind(id, runId, userId, reminderId, title, body, createdAt).run();
  const row = await db.prepare("SELECT id, reminder_id, title, body, created_at, read_at FROM notifications WHERE run_id = ?1")
    .bind(runId).first<NotificationRow>();
  if (!row) throw new Error("Could not persist the notification.");
  return toNotification(row);
}

async function setRunChannel(db: D1Database, runId: string, column: "app_status" | "email_status", status: string): Promise<void> {
  await db.prepare(`UPDATE reminder_runs SET ${column} = ?1 WHERE id = ?2`).bind(status, runId).run();
}

export function nextOccurrence(scheduledFor: string, timezone: string, recurrence: ReminderRecurrence): string | null {
  if (recurrence === "none") return null;
  validateTimeZone(timezone);
  const parts = zonedParts(new Date(scheduledFor), timezone);
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  if (recurrence === "daily") calendar.setUTCDate(calendar.getUTCDate() + 1);
  if (recurrence === "weekly") calendar.setUTCDate(calendar.getUTCDate() + 7);
  if (recurrence === "monthly") {
    const targetMonth = calendar.getUTCMonth() + 1;
    const targetYear = calendar.getUTCFullYear() + Math.floor(targetMonth / 12);
    const normalizedMonth = targetMonth % 12;
    const day = Math.min(parts.day, new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate());
    calendar.setUTCFullYear(targetYear, normalizedMonth, day);
  }
  return zonedLocalToUtc({
    year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(),
    hour: calendar.getUTCHours(), minute: calendar.getUTCMinutes(), second: calendar.getUTCSeconds(),
  }, timezone).toISOString();
}

function zonedLocalToUtc(parts: ZonedParts, timezone: string): Date {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const rendered = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += desired - rendered;
  }
  return new Date(candidate);
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function zonedParts(date: Date, timezone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function validateSchedule(runAt: string, timezone: string): void {
  validateTimeZone(timezone);
  const timestamp = Date.parse(runAt);
  if (!Number.isFinite(timestamp)) throw new Error("The reminder time is invalid.");
  if (timestamp < Date.now() - 5_000) throw new Error("The reminder time must be in the future.");
}

function validateTimeZone(timezone: string): void {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("The reminder timezone is invalid."); }
}

function formatInZone(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id, title: row.title, notes: row.notes, runAt: row.run_at, nextRunAt: row.next_run_at ?? undefined,
    timezone: row.timezone, recurrence: row.recurrence, appEnabled: Boolean(row.app_enabled), emailEnabled: Boolean(row.email_enabled),
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastRunAt: row.last_run_at ?? undefined,
  };
}

function toNotification(row: NotificationRow): EvaNotification {
  return { id: row.id, reminderId: row.reminder_id ?? undefined, taskId: row.task_id ?? undefined, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at ?? undefined };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown reminder delivery error";
}
