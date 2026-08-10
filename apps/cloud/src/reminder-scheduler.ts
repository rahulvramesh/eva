import { DurableObject } from "cloudflare:workers";
import { listReminders, nextReminderTime, processDueReminders } from "./reminders";

export class ReminderScheduler extends DurableObject<Env> {
  async refresh(userId: string): Promise<void> {
    await this.ctx.storage.put("user-id", userId);
    await this.scheduleNext(userId, 1_000);
  }

  async alarm(): Promise<void> {
    const userId = await this.ctx.storage.get<string>("user-id");
    if (!userId) return;
    try {
      const agent = this.env.EVA_AGENT.getByName(userId);
      await processDueReminders(this.env, userId, async (notification) => agent.notify(notification));
      await agent.syncReminders(await listReminders(this.env.DB, userId));
    } catch (error) {
      console.error(JSON.stringify({ event: "reminder.delivery.failed", userId: userId.slice(0, 12), error: error instanceof Error ? error.message : "Unknown error" }));
      await this.scheduleNext(userId, 30_000);
      return;
    }
    await this.scheduleNext(userId, 1_000);
  }

  private async scheduleNext(userId: string, minimumDelay: number): Promise<void> {
    const next = await nextReminderTime(this.env.DB, userId);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + minimumDelay));
  }
}
