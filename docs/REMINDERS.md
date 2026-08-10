# Eva reminders

## Behavior

Eva reminders are cloud-owned. Closing Electron, hiding its window, losing the WebSocket, or turning off the computer does not stop the schedule. D1 remains authoritative and one `ReminderScheduler` Durable Object per user holds the next Cloudflare alarm.

Supported schedules are one-time, daily, weekly, and monthly. Recurrence preserves wall-clock time in the configured IANA timezone across daylight-saving changes. A monthly schedule that falls beyond the end of a shorter month is clamped to that month's final day.

The default user timezone is persisted in notification preferences and is currently `Asia/Jakarta`. D1 stores execution instants as UTC ISO timestamps while each reminder retains its IANA timezone for display and recurrence. Traveling does not change a one-time reminder's instant. Recurring reminders stay anchored to their saved timezone until explicitly edited; **Use current** in Settings changes the default for newly created reminders.

Users can create reminders through the `schedule_reminder` model tool or in **Assistant Settings → Reminders**. The model tool requires an absolute ISO 8601 timestamp with an offset and an IANA timezone; the server rejects invalid zones and past times.

## Delivery

When an alarm fires, Eva:

1. Claims `(reminder_id, scheduled_for)` in `reminder_runs`. The unique constraint makes alarm retries idempotent at the run level.
2. Inserts one persistent D1 notification for the run.
3. Broadcasts `notification.created` through the user's `EvaAgent` Durable Object when a WebSocket is connected.
4. Electron displays a native macOS or Windows notification. The web client uses the browser Notification API after permission is granted.
5. If enabled, the Worker sends transactional email using its `EMAIL` binding and `EVA_REMINDER_FROM`.
6. Completes one-time reminders or calculates the next recurring occurrence.

Unread notifications synchronize from D1 on reconnect. Email and app delivery are independently controlled both on each reminder and in the user's global delivery preferences.

Cloudflare alarms execute at least once. Eva prevents duplicate database runs and app notifications, but no external email provider can make the interval between accepting an email and recording its success perfectly atomic. A Worker failure at exactly that boundary can theoretically produce a duplicate email on retry.

## Storage

Migration `migrations/d1/0003_reminders.sql` creates:

- `reminders`: schedule, timezone, recurrence, channels and lifecycle;
- `reminder_runs`: idempotency, attempts and per-channel delivery results;
- `notifications`: persistent app inbox and read state;
- `notification_preferences`: destination email and global channel switches.
- migration `0004_notification_timezone.sql` adds the persisted IANA timezone used by chat-created reminders.

Deleting a reminder deletes its run history and associated notifications through foreign keys and refreshes the connected notification inbox. Pausing removes its next alarm candidate; resuming schedules its stored next occurrence.

## Email configuration

Production currently sends as `Eva <reminders@notify.tarx.app>`. The sending domain must be onboarded in Cloudflare Email Service and use Cloudflare DNS.

```bash
pnpm exec wrangler email sending list
pnpm exec wrangler email sending enable notify.tarx.app # only if not already enabled
```

The binding is restricted to the configured sender in `wrangler.jsonc`:

```jsonc
"vars": { "EVA_REMINDER_FROM": "reminders@notify.tarx.app" },
"send_email": [{
  "name": "EMAIL",
  "allowed_sender_addresses": ["reminders@notify.tarx.app"]
}]
```

Local `wrangler dev` simulates email and logs it instead of sending. To perform a real delivery test, use the deployed Worker, enable email in Eva's reminder settings, and schedule a one-time reminder to an address you control. Do not set `remote: true` by default because local tests would send real email.

## Validation

The unit suite checks timezone/DST recurrence and month-end behavior. `scripts/cloud-e2e.mjs` creates a reminder five seconds in the future, waits for its Durable Object notification, marks the notification read, and removes the test reminder. It deliberately disables email so automated validation cannot send mail accidentally.

Manual email acceptance:

1. Open Eva Settings and enter an email address you control.
2. Enable App and Email notifications and save.
3. Schedule a one-time reminder two minutes ahead with both channels enabled.
4. Close Eva Desktop.
5. Confirm email delivery.
6. Reopen Eva and confirm the unread notification synchronized.

Natural-language agent acceptance:

1. Start a new chat and ask: `Remind me in one minute to verify Eva reminders. Notify me in the app only.`
2. Confirm the transcript shows a completed **Scheduled reminder** tool row rather than only a conversational promise.
3. Confirm D1 contains the absolute `run_at`, `timezone`, and requested channel flags.
4. Wait for the notification, then confirm the one-time reminder moves to `completed` and disappears from Upcoming Reminders without reconnecting.

## Future scheduled agent tasks

The current implementation schedules notifications, not unattended Bash. A future `agent_task` reminder should start a Cloudflare Workflow for cloud-safe work. Local file or Bash work must enter `waiting_for_device` while the computer is offline and must preserve Eva's approval policy; creating a reminder is not blanket authorization for a future destructive command.
