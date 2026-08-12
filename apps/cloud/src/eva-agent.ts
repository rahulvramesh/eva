import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  uiBlockSchema,
  type AgentSettings,
  type BackgroundTask,
  type ChatMessage,
  type ClientCommand,
  type DeviceCapability,
  type EvaNotification,
  type Reminder,
  type MemoryKind,
  type RoutingPolicy,
  type ServerEvent,
  type ServerEventType,
  type ToolCall,
  type UiBlock,
} from "../../../packages/protocol/src/index";
import {
  appendMessage,
  audit,
  createChat,
  createMemory,
  createToolCall,
  deleteMemory,
  ensureUser,
  getChat,
  getPendingApprovalChatId,
  getSettings,
  importTurn,
  listChats,
  listMemories,
  saveApproval,
  takeApproval,
  updateMemory,
  updateMessage,
  updateSettings,
  updateToolCall,
  upsertToolCall,
  type ModelMessage,
  type PendingApproval,
} from "./db";
import { enqueueMemory, enqueueMemoryDelete, retrieveMemories } from "./memory";
import {
  MEMORY_SAFETY_INSTRUCTION,
  claimsUnverifiedMemorySave,
  explicitlyRequestsMemory,
  isVerifiedMemoryReceipt,
} from "./memory-policy";
import { runBash, runWebFetch } from "./tools";
import { isPrivateCapableModel, shouldRouteToDevice } from "./routing";
import { consumeChatCompletionStream } from "./model-stream";
import { appendAssistantToolRequest, pendingBashCommand, toChatCompletionMessages } from "./model-protocol";
import { redactSensitiveText, redactToolInput } from "./tool-security";
import { ChatRunRegistry } from "./chat-run-registry";
import {
  createReminder,
  deleteReminder,
  getNotificationPreferences,
  listNotifications,
  listReminders,
  markNotificationRead,
  updateNotificationPreferences,
  updateReminder,
} from "./reminders";
import {
  createBackgroundTask,
  createTaskNotification,
  findBackgroundTaskByChat,
  getBackgroundTask,
  getRunnableBackgroundTask,
  hasPendingApproval,
  listBackgroundTasks,
  updateBackgroundTask,
} from "./background-tasks";

type SocketAttachment = { userId: string; identity: string; device?: DeviceCapability };
type ModelToolCall = { id: string; name: string; input: Record<string, unknown> };
type PendingDeviceTurn = {
  turnId: string;
  userId: string;
  chatId: string;
  assistantMessageId: string;
  deviceId: string;
  private: boolean;
  expiresAt: number;
  taskId?: string;
};
type PreferredDeviceModel = { deviceId: string; provider: string; modelId: string; thinkingLevel: AgentSettings["thinkingLevel"]; systemInstructions: string };

const bashInputSchema = z.object({ command: z.string().trim().min(1).max(20_000) });
const webFetchInputSchema = z.object({ url: z.string().trim().min(1).max(8_000) });
const rememberInputSchema = z.object({
  kind: z.enum(["preference", "profile", "project", "instruction", "fact"]),
  content: z.string().trim().min(1).max(2_000),
  importance: z.number().int().min(1).max(10).default(5),
});
const scheduleReminderInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4_000).default(""),
  run_at: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(100).optional(),
  recurrence: z.enum(["none", "daily", "weekly", "monthly"]).default("none"),
  app: z.boolean().default(true),
  email: z.boolean().default(false),
});
const presentPlanInputSchema = z.object({ title: z.string().min(1).max(200), steps: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(500), status: z.enum(["pending", "running", "complete", "error"]).default("pending") })).min(1).max(20) });
const presentChoiceInputSchema = z.object({ question: z.string().min(1).max(1_000), options: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(300), description: z.string().max(1_000).optional() })).min(2).max(10), allowMultiple: z.boolean().default(false) });
const presentTableInputSchema = z.object({ title: z.string().max(200).optional(), columns: z.array(z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(200) })).min(1).max(12), rows: z.array(z.record(z.string(), z.union([z.string().max(4_000), z.number(), z.boolean(), z.null()]))).max(100), caption: z.string().max(1_000).optional() });
const backgroundTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  routing: z.enum(["auto", "cloud", "device", "private"]).default("auto"),
});

const MODEL_TOOLS = [
  {
    type: "function",
    function: {
      name: "start_background_task",
      description: "Start an independent durable task when the user asks Eva to work in the background or continue separately. The task gets its own chat, survives disconnects, and reports completion in Eva.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title." },
          prompt: { type: "string", description: "A self-contained instruction with all context needed to complete the task." },
          routing: { type: "string", enum: ["auto", "cloud", "device", "private"], description: "Use cloud for cloud-only execution, device for local files/tools, private for on-device inference, or auto." },
        },
        required: ["title", "prompt", "routing"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in Eva's isolated cloud workspace. The user must approve every invocation before execution.",
      parameters: { type: "object", properties: { command: { type: "string", description: "The Bash command to execute." } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch readable text or JSON from a public HTTP or HTTPS URL.",
      parameters: { type: "object", properties: { url: { type: "string", description: "The public URL to fetch." } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a durable personal preference, profile fact, project context, or instruction. Never save credentials, secrets, or transient details.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: "One of preference, profile, project, instruction, or fact." },
          content: { type: "string", description: "A concise standalone memory." },
          importance: { type: "number", description: "Importance from 1 to 10." },
        },
        required: ["kind", "content", "importance"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_reminder",
      description: "Create a durable reminder that can notify the Eva app and email. Resolve relative dates using the current date and the user's configured timezone. Use an absolute ISO 8601 timestamp with an offset.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short reminder title." },
          notes: { type: "string", description: "Optional reminder details." },
          run_at: { type: "string", description: "Absolute ISO 8601 time including an offset, for example 2026-08-11T09:00:00+07:00." },
          timezone: { type: "string", description: "Optional IANA timezone override. Omit to use the user's configured timezone." },
          recurrence: { type: "string", enum: ["none", "daily", "weekly", "monthly"] },
          app: { type: "boolean", description: "Deliver through Eva and native desktop notifications." },
          email: { type: "boolean", description: "Also send to the configured reminder email." },
        },
        required: ["title", "run_at", "recurrence", "app", "email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "List the user's current reminders, including IDs, times, recurrence, channels, and status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "Cancel and permanently delete a reminder by ID. Call list_reminders first when the ID is not known.",
      parameters: { type: "object", properties: { reminder_id: { type: "string" } }, required: ["reminder_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "present_plan",
      description: "Present a concise task plan with explicit progress states. Use this instead of a Markdown checklist when tracking work.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          steps: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, status: { type: "string", enum: ["pending", "running", "complete", "error"] } }, required: ["id", "label"] } },
        },
        required: ["title", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_choice",
      description: "Ask the user to select from clear options. Use it when the next step depends on a user decision.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" } }, required: ["id", "label"] } },
          allowMultiple: { type: "boolean" },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_table",
      description: "Present structured comparison data in a compact table. Do not repeat the table in Markdown.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          columns: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } }, required: ["key", "label"] } },
          rows: { type: "array", items: { type: "object" } },
          caption: { type: "string" },
        },
        required: ["columns", "rows"],
      },
    },
  },
] satisfies ChatCompletionTool[];

export class EvaAgent extends DurableObject<Env> {
  private sequence = 0;
  private readonly runs = new ChatRunRegistry();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const userId = request.headers.get("x-eva-user-id");
    const identity = request.headers.get("x-eva-identity");
    if (!userId || !identity) return new Response("Unauthorized", { status: 401 });
    await ensureUser(this.env.DB, userId, identity);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ userId, identity } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [userId]);
    this.send(server, "server.hello", { protocolVersion: PROTOCOL_VERSION, agentMode: "hybrid" });
    this.send(server, "device.presence", { devices: this.connectedDevices() });
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
    const protocol = protocols.includes("eva-v3") ? "eva-v3" : protocols.includes("eva-v2") ? "eva-v2" : undefined;
    const headers = protocol ? { "sec-websocket-protocol": protocol } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      socket.close(1008, "Missing identity");
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = clientCommandSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.send(socket, "server.error", { code: "INVALID_COMMAND", message: "The command was not valid." });
      return;
    }
    try {
      await this.dispatch(socket, attachment.userId, parsed.data);
    } catch (error) {
      this.send(socket, "server.error", {
        code: "COMMAND_FAILED",
        message: errorMessage(error),
        requestId: parsed.data.requestId,
      });
    }
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    console.error(JSON.stringify({ event: "eva.websocket.error", userId: attachment?.userId.slice(0, 12), error: errorMessage(error) }));
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.device) {
      const pendingTurns = await this.pendingDeviceTurns();
      for (const pending of pendingTurns.filter((turn) => turn.deviceId === attachment.device?.id)) {
        await this.failDeviceTurn(pending, "The selected Eva desktop disconnected during the turn.");
      }
    }
    this.broadcast("device.presence", { devices: this.connectedDevices() });
  }

  private async dispatch(socket: WebSocket, userId: string, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "chat.list":
        this.send(socket, "chat.list", { chats: await listChats(this.env.DB, userId) });
        return;
      case "chat.create": {
        const chat = await createChat(this.env.DB, userId);
        this.broadcast("chat.created", { chat });
        return;
      }
      case "chat.open":
        this.send(socket, "chat.snapshot", { chat: await getChat(this.env.DB, userId, command.chatId) });
        return;
      case "settings.get":
        this.send(socket, "settings.snapshot", { settings: await this.hybridSettings(userId) });
        return;
      case "settings.update": {
        if (this.runs.hasActive() || (await this.activeDeviceChatIds()).length) throw new Error("Stop the current responses before changing model settings.");
        const deviceModel = this.findDeviceModel(command.provider, command.modelId);
        if (deviceModel) {
          const preferred: PreferredDeviceModel = {
            deviceId: deviceModel.device.id,
            provider: command.provider,
            modelId: command.modelId,
            thinkingLevel: command.thinkingLevel,
            systemInstructions: command.systemInstructions,
          };
          await this.ctx.storage.put("preferred-device-model", preferred);
          this.broadcast("device.settings.update", preferred);
          this.broadcast("settings.updated", { settings: await this.hybridSettings(userId) });
          return;
        }
        const current = await getSettings(this.env.DB, this.env, userId);
        const settings = await updateSettings(this.env.DB, this.env, userId, {
          ...current,
          selectedModel: { provider: command.provider, id: command.modelId },
          thinkingLevel: command.thinkingLevel,
          systemInstructions: command.systemInstructions,
        });
        await this.ctx.storage.delete("preferred-device-model");
        this.broadcast("settings.updated", { settings: { ...settings, models: this.hybridModels(settings.models) } });
        return;
      }
      case "memory.list":
        this.send(socket, "memory.snapshot", { memories: await listMemories(this.env.DB, userId) });
        return;
      case "memory.create": {
        const memory = await createMemory(this.env.DB, userId, command);
        await enqueueMemory(this.env, userId, memory);
        await audit(this.env.DB, userId, "memory.created", memory.id, { source: "user" });
        this.broadcast("memory.updated", { memory });
        return;
      }
      case "memory.update": {
        const memory = await updateMemory(this.env.DB, userId, {
          id: command.memoryId,
          kind: command.kind,
          content: command.content,
          importance: command.importance,
          status: command.status,
        });
        await enqueueMemory(this.env, userId, memory);
        await audit(this.env.DB, userId, "memory.updated", memory.id);
        this.broadcast("memory.updated", { memory });
        return;
      }
      case "memory.delete":
        await deleteMemory(this.env.DB, userId, command.memoryId);
        await enqueueMemoryDelete(this.env, userId, command.memoryId);
        await audit(this.env.DB, userId, "memory.deleted", command.memoryId);
        this.broadcast("memory.deleted", { memoryId: command.memoryId });
        return;
      case "reminder.list":
        this.send(socket, "reminder.snapshot", { reminders: await listReminders(this.env.DB, userId) });
        return;
      case "reminder.create": {
        const reminder = await createReminder(this.env.DB, userId, command);
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        await audit(this.env.DB, userId, "reminder.created", reminder.id);
        this.broadcast("reminder.updated", { reminder });
        return;
      }
      case "reminder.update": {
        const reminder = await updateReminder(this.env.DB, userId, {
          id: command.reminderId,
          title: command.title,
          notes: command.notes,
          runAt: command.runAt,
          timezone: command.timezone,
          recurrence: command.recurrence,
          appEnabled: command.appEnabled,
          emailEnabled: command.emailEnabled,
          status: command.status,
        });
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        await audit(this.env.DB, userId, "reminder.updated", reminder.id);
        this.broadcast("reminder.updated", { reminder });
        return;
      }
      case "reminder.delete":
        await deleteReminder(this.env.DB, userId, command.reminderId);
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        await audit(this.env.DB, userId, "reminder.deleted", command.reminderId);
        this.broadcast("reminder.deleted", { reminderId: command.reminderId });
        this.broadcast("notification.snapshot", { notifications: await listNotifications(this.env.DB, userId) });
        return;
      case "task.list":
        this.send(socket, "task.snapshot", { tasks: await listBackgroundTasks(this.env.DB, userId) });
        return;
      case "task.create": {
        const task = await this.createAndScheduleBackgroundTask(userId, {
          title: command.title,
          prompt: command.prompt,
          routing: command.routing,
        });
        this.broadcast("task.updated", { task });
        return;
      }
      case "task.cancel": {
        const existing = await getBackgroundTask(this.env.DB, userId, command.taskId);
        this.runs.requestAbort(existing.chatId);
        await this.abortDeviceTurn(existing.chatId);
        const task = await updateBackgroundTask(this.env.DB, userId, existing.id, {
          status: "cancelled",
          progress: "Cancelled",
        });
        await audit(this.env.DB, userId, "task.cancelled", task.id);
        this.broadcast("task.updated", { task });
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        return;
      }
      case "notification.list":
        this.send(socket, "notification.snapshot", { notifications: await listNotifications(this.env.DB, userId) });
        return;
      case "notification.read": {
        const readAt = await markNotificationRead(this.env.DB, userId, command.notificationId);
        this.broadcast("notification.read", { notificationId: command.notificationId, readAt });
        return;
      }
      case "notification.preferences.get":
        this.send(socket, "notification.preferences", { preferences: await getNotificationPreferences(this.env.DB, userId) });
        return;
      case "notification.preferences.update": {
        const preferences = await updateNotificationPreferences(this.env.DB, userId, command);
        this.broadcast("notification.preferences", { preferences });
        return;
      }
      case "run.abort":
        this.runs.requestAbort(command.chatId);
        await this.abortDeviceTurn(command.chatId);
        return;
      case "tool.approve":
        await this.approveTool(userId, command.toolCallId);
        return;
      case "tool.reject":
        await this.rejectTool(userId, command.toolCallId);
        return;
      case "ui.choice.submit":
        this.runs.start(command.chatId, await this.activeDeviceChatIds());
        this.ctx.waitUntil(this.submitChoice(userId, command.chatId, command.messageId, command.blockId, command.selected).catch((error) => {
          this.runs.finish(command.chatId);
          this.broadcast("server.error", { code: "UI_ACTION_FAILED", message: errorMessage(error) });
        }));
        return;
      case "message.send":
        this.runs.start(command.chatId, await this.activeDeviceChatIds());
        this.ctx.waitUntil(this.routePrompt(userId, command.chatId, command.content, command.routing ?? "auto").catch((error) => {
          this.runs.finish(command.chatId);
          this.broadcast("server.error", { code: "ROUTING_ERROR", message: errorMessage(error) });
        }));
        return;
      case "device.register": {
        const attachment = socket.deserializeAttachment() as SocketAttachment;
        const device = { ...command.device, connectedAt: new Date().toISOString() };
        socket.serializeAttachment({ ...attachment, device } satisfies SocketAttachment);
        this.broadcast("device.presence", { devices: this.connectedDevices() });
        this.broadcast("settings.updated", { settings: await this.hybridSettings(userId) });
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        return;
      }
      case "device.turn.delta":
        await this.acceptDeviceDelta(socket, command.turnId, command.delta);
        return;
      case "device.turn.tool":
        await this.acceptDeviceTool(socket, command.turnId, command.toolCall);
        return;
      case "device.turn.complete":
        await this.acceptDeviceCompletion(socket, command.turnId, command.content, command.status, command.uiBlocks);
        return;
      case "sync.turn.push":
        await importTurn(this.env.DB, userId, command);
        this.send(socket, "sync.turn.ack", { chatId: command.chatId, assistantMessageId: command.assistantMessage.id });
        this.broadcast("chat.snapshot", { chat: await getChat(this.env.DB, userId, command.chatId) });
        this.broadcast("chat.list", { chats: await listChats(this.env.DB, userId) });
        return;
      case "device.turn.execute":
        throw new Error("Device execution commands are accepted only by Eva Desktop.");
      case "device.turn.abort":
        throw new Error("Device abort commands are sent by Eva Cloud, not accepted from clients.");
    }
  }

  private async routePrompt(userId: string, chatId: string, content: string, routing: RoutingPolicy, taskId?: string): Promise<void> {
    const preferred = await this.ctx.storage.get<PreferredDeviceModel>("preferred-device-model");
    const requestedDevice = preferred ? this.connectedDevices().find((device) => device.id === preferred.deviceId) : undefined;
    const device = requestedDevice ?? this.connectedDevices()[0];
    const effectivePreferred = requestedDevice ? preferred : undefined;
    const useDevice = shouldRouteToDevice(routing, content, Boolean(device), Boolean(effectivePreferred));
    if (useDevice && device) {
      if (routing === "private") {
        const model = effectivePreferred
          ? device.models.find((candidate) => candidate.provider === effectivePreferred?.provider && candidate.id === effectivePreferred.modelId)
          : device.models.find((candidate) => candidate.available !== false);
        if (!isPrivateCapableModel(model)) throw new Error("Private mode requires an on-device model such as Ollama. The selected Pi model uses a remote provider.");
      }
      await this.runDevicePrompt(userId, chatId, content, routing, device, effectivePreferred, taskId);
      return;
    }
    if ((routing === "device" || routing === "private") && !device) throw new Error("Your Eva desktop device is offline.");
    await this.runPrompt(userId, chatId, content);
  }

  private async submitChoice(userId: string, chatId: string, messageId: string, blockId: string, selected: string[]): Promise<void> {
    const chat = await getChat(this.env.DB, userId, chatId);
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    const block = message?.uiBlocks.find((candidate) => candidate.id === blockId && candidate.kind === "choice");
    if (!message || !block || block.kind !== "choice" || block.status === "submitted") throw new Error("That choice is no longer available.");
    const allowed = new Set(block.options.map((option) => option.id));
    if (selected.some((id) => !allowed.has(id)) || (!block.allowMultiple && selected.length !== 1)) throw new Error("The selected option was not valid.");
    const updatedMessage = { ...message, uiBlocks: message.uiBlocks.map((candidate) => candidate.id === blockId ? { ...block, selected, status: "submitted" as const } : candidate) };
    await updateMessage(this.env.DB, userId, chatId, messageId, { uiBlocks: updatedMessage.uiBlocks });
    this.broadcast("message.updated", { chatId, message: updatedMessage });
    const labels = block.options.filter((option) => selected.includes(option.id)).map((option) => option.label);
    await this.runPrompt(userId, chatId, `I selected: ${labels.join(", ")}. Continue based on this choice.`);
  }

  private async runDevicePrompt(
    userId: string,
    chatId: string,
    content: string,
    routing: RoutingPolicy,
    device: DeviceCapability,
    preferred?: PreferredDeviceModel,
    taskId?: string,
  ): Promise<void> {
    const turnId = crypto.randomUUID();
    try {
      const model = preferred ? `${preferred.provider}/${preferred.modelId}` : selectedDeviceModel(device);
      const provenance = { executionHost: "device" as const, deviceId: device.id, model, private: routing === "private" };
      const userMessage = await appendMessage(this.env.DB, userId, chatId, "user", content, "complete", provenance);
      this.broadcast("message.append", { chatId, message: userMessage });
      const assistant = await appendMessage(this.env.DB, userId, chatId, "assistant", "", "streaming", provenance);
      this.broadcast("message.append", { chatId, message: assistant });
      const pending: PendingDeviceTurn = {
        turnId,
        userId,
        chatId,
        assistantMessageId: assistant.id,
        deviceId: device.id,
        private: routing === "private",
        expiresAt: Date.now() + 5 * 60_000,
        taskId,
      };
      await this.ctx.storage.put(`device-turn:${turnId}`, pending);
      await this.scheduleDeviceAlarm();
      this.broadcast("run.status", { chatId, status: "running" });
      this.broadcast("route.status", {
        chatId,
        turnId,
        host: "device",
        deviceId: device.id,
        model,
        private: routing === "private",
        status: "running",
      });
      const chat = await getChat(this.env.DB, userId, chatId);
      let delivered = false;
      for (const candidate of this.ctx.getWebSockets()) {
        const attachment = candidate.deserializeAttachment() as SocketAttachment | null;
        if (attachment?.device?.id !== device.id) continue;
        this.send(candidate, "device.turn.request", { turnId, chat, content, routing });
        delivered = true;
      }
      if (!delivered) throw new Error("The selected Eva desktop disconnected before the turn started.");
    } catch (error) {
      const pending = await this.ctx.storage.get<PendingDeviceTurn>(`device-turn:${turnId}`);
      if (pending) {
        await this.failDeviceTurn(pending, errorMessage(error));
        if (pending.taskId) return;
      }
      else {
        this.runs.finish(chatId);
        await this.ctx.storage.delete([`device-turn:${turnId}`, `active-device-turn:${chatId}`]);
        this.broadcast("route.status", { chatId, turnId, host: "device", deviceId: device.id, private: routing === "private", status: "error" });
      }
      throw error;
    }
  }

  private async acceptDeviceDelta(socket: WebSocket, turnId: string, delta: string): Promise<void> {
    const pending = await this.authorizeDeviceTurn(socket, turnId);
    this.broadcast("assistant.delta", { chatId: pending.chatId, messageId: pending.assistantMessageId, delta });
    this.broadcast("device.turn.delta", { turnId, chatId: pending.chatId, messageId: pending.assistantMessageId, delta });
  }

  private async acceptDeviceTool(socket: WebSocket, turnId: string, toolCall: ToolCall): Promise<void> {
    const pending = await this.authorizeDeviceTurn(socket, turnId);
    if (toolCall.assistantMessageId !== pending.assistantMessageId) throw new Error("The device tool call targeted the wrong message.");
    await upsertToolCall(this.env.DB, pending.userId, pending.chatId, toolCall);
    this.broadcast("device.turn.tool", { turnId, chatId: pending.chatId, toolCall });
    if (toolCall.status === "running") this.broadcast("tool.call", { chatId: pending.chatId, toolCall });
    else this.broadcast("tool.update", { chatId: pending.chatId, toolCall });
  }

  private async acceptDeviceCompletion(
    socket: WebSocket,
    turnId: string,
    content: string,
    status: "complete" | "aborted" | "error",
    uiBlocks: UiBlock[],
  ): Promise<void> {
    const pending = await this.authorizeDeviceTurn(socket, turnId);
    await updateMessage(this.env.DB, pending.userId, pending.chatId, pending.assistantMessageId, { content, status, uiBlocks });
    await this.ctx.storage.delete([`device-turn:${turnId}`, `active-device-turn:${pending.chatId}`]);
    this.runs.finish(pending.chatId);
    await this.scheduleDeviceAlarm();
    this.broadcast("device.turn.complete", {
      turnId,
      chatId: pending.chatId,
      messageId: pending.assistantMessageId,
      content,
      status,
      uiBlocks,
    });
    this.broadcast("run.status", { chatId: pending.chatId, status: status === "complete" ? "idle" : status });
    this.broadcast("route.status", {
      chatId: pending.chatId,
      turnId,
      host: "device",
      deviceId: pending.deviceId,
      private: pending.private,
      status: status === "complete" ? "complete" : "error",
    });
    this.broadcast("chat.list", { chats: await listChats(this.env.DB, pending.userId) });
    if (pending.taskId) await this.finalizeBackgroundTaskForChat(pending.userId, pending.chatId);
  }

  private async authorizeDeviceTurn(socket: WebSocket, turnId: string): Promise<PendingDeviceTurn> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const pending = await this.ctx.storage.get<PendingDeviceTurn>(`device-turn:${turnId}`);
    if (!attachment?.device || !pending || attachment.userId !== pending.userId || attachment.device.id !== pending.deviceId) {
      throw new Error("This device is not authorized for that turn.");
    }
    return pending;
  }

  private async abortDeviceTurn(chatId: string): Promise<void> {
    const pending = (await this.pendingDeviceTurns()).find((turn) => turn.chatId === chatId);
    if (!pending) return;
    for (const candidate of this.ctx.getWebSockets()) {
      const attachment = candidate.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.device?.id === pending.deviceId) this.send(candidate, "device.turn.abort", { turnId: pending.turnId, chatId });
    }
  }

  private async failDeviceTurn(pending: PendingDeviceTurn, message: string): Promise<void> {
    await updateMessage(this.env.DB, pending.userId, pending.chatId, pending.assistantMessageId, { content: message, status: "error" });
    await this.ctx.storage.delete([`device-turn:${pending.turnId}`, `active-device-turn:${pending.chatId}`]);
    this.runs.finish(pending.chatId);
    await this.scheduleDeviceAlarm();
    this.broadcast("device.turn.complete", {
      turnId: pending.turnId,
      chatId: pending.chatId,
      messageId: pending.assistantMessageId,
      content: message,
      status: "error",
      uiBlocks: [],
    });
    this.broadcast("run.status", { chatId: pending.chatId, status: "error" });
    this.broadcast("route.status", {
      chatId: pending.chatId,
      turnId: pending.turnId,
      host: "device",
      deviceId: pending.deviceId,
      private: pending.private,
      status: "error",
    });
    this.broadcast("chat.list", { chats: await listChats(this.env.DB, pending.userId) });
    if (pending.taskId) {
      const waiting = await updateBackgroundTask(this.env.DB, pending.userId, pending.taskId, {
        status: "waiting_device",
        progress: "Device disconnected; waiting to retry",
        error: message,
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      });
      this.broadcast("task.updated", { task: waiting });
      await this.env.REMINDER_SCHEDULER.getByName(pending.userId).refresh(pending.userId);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const pending of await this.pendingDeviceTurns()) {
      if ((pending.expiresAt ?? now) <= now) await this.failDeviceTurn(pending, "The device turn timed out after five minutes.");
    }
    await this.scheduleDeviceAlarm();
  }

  private async pendingDeviceTurns(): Promise<PendingDeviceTurn[]> {
    const entries = await this.ctx.storage.list<PendingDeviceTurn>({ prefix: "device-turn:" });
    return [...entries.values()];
  }

  private async activeDeviceChatIds(): Promise<string[]> {
    return (await this.pendingDeviceTurns()).map((turn) => turn.chatId);
  }

  private async scheduleDeviceAlarm(): Promise<void> {
    const pending = await this.pendingDeviceTurns();
    if (!pending.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...pending.map((turn) => turn.expiresAt ?? Date.now() + 5 * 60_000)));
  }

  private connectedDevices(): DeviceCapability[] {
    const devices = new Map<string, DeviceCapability>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.device) devices.set(attachment.device.id, { ...attachment.device, online: true });
    }
    return [...devices.values()];
  }

  private findDeviceModel(provider: string, modelId: string): { device: DeviceCapability; model: AgentSettings["models"][number] } | undefined {
    for (const device of this.connectedDevices()) {
      const model = device.models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
      if (model) return { device, model };
    }
    return undefined;
  }

  private hybridModels(cloudModels: AgentSettings["models"]): AgentSettings["models"] {
    return [
      ...cloudModels.map((model) => ({ ...model, executionHost: "cloud" as const, available: true })),
      ...this.connectedDevices().flatMap((device) => device.models.map((model) => ({
        ...model,
        executionHost: "device" as const,
        deviceId: device.id,
        available: true,
      }))),
    ];
  }

  private async hybridSettings(userId: string): Promise<AgentSettings> {
    const base = await getSettings(this.env.DB, this.env, userId);
    const models = this.hybridModels(base.models);
    const preferred = await this.ctx.storage.get<PreferredDeviceModel>("preferred-device-model");
    const selected = preferred && models.some((model) => model.deviceId === preferred.deviceId && model.provider === preferred.provider && model.id === preferred.modelId)
      ? { provider: preferred.provider, id: preferred.modelId }
      : base.selectedModel;
    return {
      ...base,
      models,
      selectedModel: selected,
      thinkingLevel: preferred?.thinkingLevel ?? base.thinkingLevel,
      systemInstructions: preferred?.systemInstructions ?? base.systemInstructions,
    };
  }

  private async runPrompt(userId: string, chatId: string, content: string): Promise<void> {
    const turnId = crypto.randomUUID();
    let assistant: ChatMessage | undefined;
    try {
      const settings = await getSettings(this.env.DB, this.env, userId);
      const provenance = { executionHost: "cloud" as const, model: `${settings.selectedModel.provider}/${settings.selectedModel.id}`, private: false };
      const userMessage = await appendMessage(this.env.DB, userId, chatId, "user", content, "complete", provenance);
      this.broadcast("message.append", { chatId, message: userMessage });
      assistant = await appendMessage(this.env.DB, userId, chatId, "assistant", "", "streaming", provenance);
      this.broadcast("message.append", { chatId, message: assistant });
      this.broadcast("run.status", { chatId, status: "running" });
      this.broadcast("route.status", { chatId, turnId, host: "cloud", private: false, status: "running" });

      const [chat, memories, notificationPreferences] = await Promise.all([
        getChat(this.env.DB, userId, chatId),
        retrieveMemories(this.env, userId, content),
        getNotificationPreferences(this.env.DB, userId),
      ]);
      const messages = buildModelMessages(settings, memories, notificationPreferences.timezone, chat.messages.filter((message) => message.id !== assistant!.id));
      await this.continueTurn(userId, chatId, assistant.id, messages, "");
      this.broadcast("route.status", { chatId, turnId, host: "cloud", private: false, status: "complete" });
    } catch (error) {
      if (assistant) {
        const aborted = this.runs.isAborted(chatId);
        const message = aborted ? "Stopped." : `I couldn’t complete that response: ${errorMessage(error)}`;
        await updateMessage(this.env.DB, userId, chatId, assistant.id, { content: message, status: aborted ? "aborted" : "error" });
        this.broadcast("assistant.delta", { chatId, messageId: assistant.id, delta: message });
      }
      const aborted = this.runs.isAborted(chatId);
      this.broadcast("run.status", { chatId, status: aborted ? "aborted" : "error" });
      this.broadcast("route.status", { chatId, turnId, host: "cloud", private: false, status: "error" });
      if (!aborted) this.broadcast("server.error", { code: "AGENT_ERROR", message: errorMessage(error) });
    } finally {
      this.runs.finish(chatId);
      this.broadcast("chat.list", { chats: await listChats(this.env.DB, userId) });
    }
  }

  private async continueTurn(
    userId: string,
    chatId: string,
    assistantMessageId: string,
    messages: ModelMessage[],
    prefix: string,
  ): Promise<void> {
    let content = prefix;
    const memoryRequested = explicitlyRequestsMemory(messages);
    let memoryReceipt = "";
    let memoryRetryIssued = false;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      if (this.runs.isAborted(chatId)) throw new Error("ABORTED");
      const settings = await getSettings(this.env.DB, this.env, userId);
      let streamedResponse = "";
      const shouldBufferForMemoryVerification = memoryRequested && !memoryReceipt;
      const result = await runModel(this.env, settings, messages, this.runs.signal(chatId), (delta) => {
        streamedResponse += delta;
        if (!shouldBufferForMemoryVerification) {
          content += delta;
          this.broadcast("assistant.delta", { chatId, messageId: assistantMessageId, delta });
        }
      });
      const toolCalls = normalizeToolCalls(result.tool_calls);
      if (!toolCalls.length) {
        const response = shouldBufferForMemoryVerification ? result.response ?? streamedResponse : "";
        if (memoryRequested && !memoryReceipt) {
          if (!memoryRetryIssued) {
            memoryRetryIssued = true;
            if (response) messages.push({ role: "assistant", content: response });
            messages.push({
              role: "system",
              content: "The user explicitly requested durable memory, but no memory write occurred. Call the remember tool now. Do not claim success without its verified tool receipt.",
            });
            continue;
          }
          throw new Error("Eva could not verify the requested memory write, so nothing was reported as saved.");
        }

        let finalResponse = response;
        if (!memoryReceipt && claimsUnverifiedMemorySave(finalResponse)) {
          finalResponse = "I haven't saved that to durable memory because no memory operation completed.";
        }
        if (memoryReceipt && !content.includes(memoryReceipt) && !finalResponse.includes(memoryReceipt)) {
          finalResponse = `${memoryReceipt}\n\n${finalResponse}`.trim();
        }
        if (finalResponse) {
          content += finalResponse;
          this.streamText(chatId, assistantMessageId, finalResponse);
        }
        const finalContent = content || "I couldn’t produce a response.";
        await updateMessage(this.env.DB, userId, chatId, assistantMessageId, { content: finalContent, status: "complete" });
        this.broadcast("run.status", { chatId, status: "idle" });
        return;
      }

      if (shouldBufferForMemoryVerification && streamedResponse && !claimsUnverifiedMemorySave(streamedResponse)) {
        content += streamedResponse;
        this.streamText(chatId, assistantMessageId, streamedResponse);
      }

      appendAssistantToolRequest(messages, result.response ?? streamedResponse, toolCalls);

      for (const request of toolCalls) {
        const needsApproval = request.name === "bash";
        const toolCall = await createToolCall(
          this.env.DB,
          userId,
          chatId,
          assistantMessageId,
          request.name,
          redactToolInput(request.input),
          needsApproval ? "pending" : "running",
        );
        this.broadcast("tool.call", { chatId, toolCall });

        if (needsApproval) {
          await this.appendUiBlock(userId, chatId, assistantMessageId, uiBlockSchema.parse({
            id: crypto.randomUUID(),
            kind: "approval",
            toolCallId: toolCall.id,
            title: "Run command?",
            description: redactSensitiveText(String(request.input.command ?? "This command will run in Eva's isolated cloud workspace.")),
            risk: "medium",
            createdAt: new Date().toISOString(),
          }));
          await saveApproval(this.env.DB, userId, chatId, assistantMessageId, toolCall.id, request.id, messages);
          await updateMessage(this.env.DB, userId, chatId, assistantMessageId, { content, status: "complete" });
          await audit(this.env.DB, userId, "tool.approval.requested", toolCall.id, { tool: "bash" });
          this.broadcast("run.status", { chatId, status: "idle" });
          return;
        }

        const output = await this.executeAutomaticTool(userId, chatId, assistantMessageId, request, toolCall);
        if (request.name === "remember" && isVerifiedMemoryReceipt(output)) memoryReceipt = output;
        messages.push({ role: "tool", content: output, tool_call_id: request.id });
      }
    }
    throw new Error("Eva exceeded the tool-call iteration limit.");
  }

  private async executeAutomaticTool(
    userId: string,
    chatId: string,
    assistantMessageId: string,
    request: ModelToolCall,
    toolCall: ToolCall,
  ): Promise<string> {
    try {
      let output: string;
      if (request.name === "present_plan" || request.name === "present_choice" || request.name === "present_table") {
        const block = generativeUiBlock(request.name, request.input);
        await this.appendUiBlock(userId, chatId, assistantMessageId, block);
        output = `Presented ${block.kind} in Eva.`;
      } else if (request.name === "web_fetch") {
        output = await runWebFetch(webFetchInputSchema.parse(request.input).url);
      } else if (request.name === "remember") {
        const input = rememberInputSchema.parse(request.input);
        const memory = await createMemory(this.env.DB, userId, {
          kind: input.kind as MemoryKind,
          content: input.content,
          importance: input.importance,
          sourceChatId: chatId,
          sourceMessageId: assistantMessageId,
        });
        await enqueueMemory(this.env, userId, memory);
        this.broadcast("memory.updated", { memory });
        output = `Memory saved ✓ [${memory.id.slice(0, 8)}]: ${memory.content}`;
      } else if (request.name === "schedule_reminder") {
        const input = scheduleReminderInputSchema.parse(request.input);
        const preferences = await getNotificationPreferences(this.env.DB, userId);
        const reminder = await createReminder(this.env.DB, userId, {
          title: input.title,
          notes: input.notes,
          runAt: input.run_at,
          timezone: input.timezone ?? preferences.timezone,
          recurrence: input.recurrence,
          appEnabled: input.app,
          emailEnabled: input.email,
        });
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        this.broadcast("reminder.updated", { reminder });
        await this.appendUiBlock(userId, chatId, assistantMessageId, uiBlockSchema.parse({
          id: crypto.randomUUID(), kind: "reminder", reminderId: reminder.id, title: reminder.title, notes: reminder.notes,
          runAt: reminder.nextRunAt ?? reminder.runAt, timezone: reminder.timezone, recurrence: reminder.recurrence,
          appEnabled: reminder.appEnabled, emailEnabled: reminder.emailEnabled, status: reminder.status, createdAt: new Date().toISOString(),
        }));
        const emailNote = input.email && (!preferences.emailEnabled || !preferences.email)
          ? " Email delivery is requested but must be enabled with an address in Settings."
          : "";
        output = `Reminder scheduled ✓ [${reminder.id.slice(0, 8)}] for ${reminder.runAt} (${reminder.timezone}).${emailNote}`;
      } else if (request.name === "start_background_task") {
        const input = backgroundTaskInputSchema.parse(request.input);
        const task = await this.createAndScheduleBackgroundTask(userId, {
          title: input.title,
          prompt: input.prompt,
          routing: input.routing,
          sourceChatId: chatId,
        });
        this.broadcast("task.updated", { task });
        output = `Background task queued ✓ [${task.id.slice(0, 8)}]: ${task.title}.`;
      } else if (request.name === "list_reminders") {
        const reminders = await listReminders(this.env.DB, userId);
        output = reminders.length
          ? reminders.map((reminder) => `${reminder.id} | ${reminder.status} | ${reminder.title} | ${reminder.nextRunAt ?? reminder.runAt} | ${reminder.timezone} | ${reminder.recurrence} | app=${reminder.appEnabled} email=${reminder.emailEnabled}`).join("\n")
          : "No reminders are currently saved.";
      } else if (request.name === "cancel_reminder") {
        const input = z.object({ reminder_id: z.string().uuid() }).parse(request.input);
        await deleteReminder(this.env.DB, userId, input.reminder_id);
        await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
        this.broadcast("reminder.deleted", { reminderId: input.reminder_id });
        this.broadcast("notification.snapshot", { notifications: await listNotifications(this.env.DB, userId) });
        output = `Reminder cancelled ✓ [${input.reminder_id.slice(0, 8)}].`;
      } else {
        throw new Error(`Unknown tool ${request.name}.`);
      }
      const updated = await updateToolCall(this.env.DB, userId, toolCall.id, "complete", output);
      this.broadcast("tool.update", { chatId, toolCall: updated });
      await audit(this.env.DB, userId, "tool.completed", toolCall.id, { tool: request.name });
      return output;
    } catch (error) {
      const output = errorMessage(error);
      const updated = await updateToolCall(this.env.DB, userId, toolCall.id, "error", output);
      this.broadcast("tool.update", { chatId, toolCall: updated });
      return `Tool failed: ${output}`;
    }
  }

  private async appendUiBlock(userId: string, chatId: string, assistantMessageId: string, block: UiBlock): Promise<void> {
    const chat = await getChat(this.env.DB, userId, chatId);
    const message = chat.messages.find((candidate) => candidate.id === assistantMessageId);
    if (!message) throw new Error("The assistant message for this UI block was not found.");
    const updated = { ...message, uiBlocks: [...message.uiBlocks.filter((candidate) => candidate.id !== block.id), block] };
    await updateMessage(this.env.DB, userId, chatId, assistantMessageId, { uiBlocks: updated.uiBlocks });
    this.broadcast("message.updated", { chatId, message: updated });
  }

  private async approveTool(userId: string, toolCallId: string): Promise<void> {
    const chatId = await getPendingApprovalChatId(this.env.DB, userId, toolCallId);
    this.runs.start(chatId, await this.activeDeviceChatIds());
    let approval: PendingApproval;
    try {
      approval = await takeApproval(this.env.DB, userId, toolCallId, "approved");
    } catch (error) {
      this.runs.finish(chatId);
      throw error;
    }
    this.broadcast("run.status", { chatId: approval.chatId, status: "running" });
    let toolCall: ToolCall | undefined;
    try {
      toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "running", "");
      this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
      const command = pendingBashCommand(approval.modelMessages, approval.modelToolCallId);
      let toolResult: string;
      try {
        toolResult = redactSensitiveText(await runBash(this.env, userId, command));
        toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "complete", toolResult);
      } catch (error) {
        toolResult = `Tool failed: ${redactSensitiveText(errorMessage(error))}`;
        toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "error", toolResult);
      }
      this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
      await audit(this.env.DB, userId, "tool.approved", toolCallId, { tool: "bash" });
      const chat = await getChat(this.env.DB, userId, approval.chatId);
      const assistant = chat.messages.find((message) => message.id === approval.assistantMessageId);
      approval.modelMessages.push({ role: "tool", content: toolResult, tool_call_id: approval.modelToolCallId });
      await this.continueTurn(userId, approval.chatId, approval.assistantMessageId, approval.modelMessages, assistant?.content ?? "");
    } catch (error) {
      const output = redactSensitiveText(errorMessage(error));
      if (!toolCall || !["complete", "error", "rejected"].includes(toolCall.status)) {
        toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "error", output);
        this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
      }
      const chat = await getChat(this.env.DB, userId, approval.chatId);
      const assistant = chat.messages.find((message) => message.id === approval.assistantMessageId);
      const failure = `I couldn’t complete the response after that command: ${output}`;
      await updateMessage(this.env.DB, userId, approval.chatId, approval.assistantMessageId, {
        content: `${assistant?.content ?? ""}\n\n${failure}`.trim(),
        status: "error",
      });
      this.broadcast("assistant.delta", { chatId: approval.chatId, messageId: approval.assistantMessageId, delta: `\n\n${failure}` });
      this.broadcast("server.error", { code: "TOOL_FAILED", message: output });
      this.broadcast("run.status", { chatId: approval.chatId, status: "error" });
    } finally {
      this.runs.finish(approval.chatId);
      await this.finalizeBackgroundTaskForChat(userId, approval.chatId);
    }
  }

  private async rejectTool(userId: string, toolCallId: string): Promise<void> {
    const approval = await takeApproval(this.env.DB, userId, toolCallId, "rejected");
    const toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "rejected", "Rejected by the user.");
    this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
    await audit(this.env.DB, userId, "tool.rejected", toolCallId, { tool: "bash" });
    const task = await findBackgroundTaskByChat(this.env.DB, userId, approval.chatId);
    if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
      const failed = await updateBackgroundTask(this.env.DB, userId, task.id, {
        status: "failed",
        progress: "Approval rejected",
        error: "The required tool approval was rejected.",
      });
      this.broadcast("task.updated", { task: failed });
      await this.notifyTaskCompletion(userId, failed);
    }
  }

  private async createAndScheduleBackgroundTask(
    userId: string,
    input: { title: string; prompt: string; routing: RoutingPolicy; sourceChatId?: string },
  ): Promise<BackgroundTask> {
    const task = await createBackgroundTask(this.env.DB, userId, input);
    await audit(this.env.DB, userId, "task.created", task.id, { routing: task.routing });
    await this.env.REMINDER_SCHEDULER.getByName(userId).refresh(userId);
    return task;
  }

  async processBackgroundTask(userId: string): Promise<void> {
    const task = await getRunnableBackgroundTask(this.env.DB, userId);
    if (!task) return;
    const preferred = await this.ctx.storage.get<PreferredDeviceModel>("preferred-device-model");
    const requestedDevice = preferred ? this.connectedDevices().find((device) => device.id === preferred.deviceId) : undefined;
    const device = requestedDevice ?? this.connectedDevices()[0];
    const useDevice = shouldRouteToDevice(task.routing, task.prompt, Boolean(device), Boolean(requestedDevice && preferred));

    if ((task.routing === "device" || task.routing === "private") && !device) {
      const waiting = await updateBackgroundTask(this.env.DB, userId, task.id, {
        status: "waiting_device",
        progress: "Waiting for an Eva desktop device",
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      });
      this.broadcast("task.updated", { task: waiting });
      return;
    }

    try {
      this.runs.start(task.chatId, await this.activeDeviceChatIds());
    } catch {
      const queued = await updateBackgroundTask(this.env.DB, userId, task.id, {
        status: "queued",
        progress: "Waiting for an execution slot",
        retryAt: new Date(Date.now() + 5_000).toISOString(),
      });
      this.broadcast("task.updated", { task: queued });
      return;
    }

    const running = await updateBackgroundTask(this.env.DB, userId, task.id, {
      status: "running",
      progress: useDevice ? "Running on device" : "Running in cloud",
      executionHost: useDevice ? "device" : "cloud",
      deviceId: useDevice ? device?.id : undefined,
    });
    this.broadcast("task.updated", { task: running });
    try {
      await this.routePrompt(userId, task.chatId, task.prompt, task.routing, task.id);
      const current = await getBackgroundTask(this.env.DB, userId, task.id);
      if (current.status === "waiting_device") return;
      const pendingDevice = (await this.pendingDeviceTurns()).some((turn) => turn.taskId === task.id);
      if (!pendingDevice) await this.finalizeBackgroundTaskForChat(userId, task.chatId);
    } catch (error) {
      this.runs.finish(task.chatId);
      const failed = await updateBackgroundTask(this.env.DB, userId, task.id, {
        status: "failed",
        progress: "Failed",
        error: errorMessage(error),
      });
      this.broadcast("task.updated", { task: failed });
      await this.notifyTaskCompletion(userId, failed);
    }
  }

  private async finalizeBackgroundTaskForChat(userId: string, chatId: string): Promise<void> {
    const task = await findBackgroundTaskByChat(this.env.DB, userId, chatId);
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
    if (await hasPendingApproval(this.env.DB, userId, chatId)) {
      const waiting = await updateBackgroundTask(this.env.DB, userId, task.id, {
        status: "waiting_approval",
        progress: "Waiting for approval",
      });
      this.broadcast("task.updated", { task: waiting });
      return;
    }
    const chat = await getChat(this.env.DB, userId, chatId);
    const assistant = [...chat.messages].reverse().find((message) => message.role === "assistant");
    const successful = assistant?.status === "complete";
    const updated = await updateBackgroundTask(this.env.DB, userId, task.id, {
      status: successful ? "completed" : "failed",
      progress: successful ? "Completed" : "Failed",
      result: successful ? assistant.content.slice(0, 20_000) : undefined,
      error: successful ? undefined : assistant?.content || "The task did not complete.",
      executionHost: assistant?.executionHost,
      deviceId: assistant?.deviceId,
      model: assistant?.model,
    });
    this.broadcast("task.updated", { task: updated });
    await audit(this.env.DB, userId, `task.${updated.status}`, updated.id);
    await this.notifyTaskCompletion(userId, updated);
  }

  private async notifyTaskCompletion(userId: string, task: BackgroundTask): Promise<void> {
    const preferences = await getNotificationPreferences(this.env.DB, userId);
    if (!preferences.appEnabled || !["completed", "failed"].includes(task.status)) return;
    const notification = await createTaskNotification(this.env.DB, userId, task);
    this.broadcast("notification.created", { notification });
  }

  private streamText(chatId: string, messageId: string, text: string): void {
    const chunks = text.match(/.{1,80}(?:\s|$)|.{1,80}/gs) ?? [text];
    for (const delta of chunks) this.broadcast("assistant.delta", { chatId, messageId, delta });
  }

  private send<T extends ServerEventType>(socket: WebSocket, type: T, payload: Extract<ServerEvent<T>, { type: T }>["payload"]): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ version: PROTOCOL_VERSION, sequence: ++this.sequence, type, payload }));
  }

  private broadcast<T extends ServerEventType>(type: T, payload: Extract<ServerEvent<T>, { type: T }>["payload"]): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, type, payload);
  }

  async notify(notification: EvaNotification): Promise<void> {
    this.broadcast("notification.created", { notification });
  }

  async syncReminders(reminders: Reminder[]): Promise<void> {
    this.broadcast("reminder.snapshot", { reminders });
  }
}

function buildModelMessages(settings: AgentSettings, memories: Awaited<ReturnType<typeof retrieveMemories>>, timezone: string, history: ChatMessage[]): ModelMessage[] {
  const memoryContext = memories.length
    ? `\n\nRelevant long-term memories:\n${memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n")}`
    : "";
  return [
    { role: "system", content: `${settings.systemInstructions}\n\nCurrent UTC time: ${new Date().toISOString()}. The user's configured timezone is ${timezone}. Use it for relative or unspecified reminder times; only override it when the user names another timezone.\n\nUse present_plan for trackable multi-step work, present_choice when the next step needs a user decision, and present_table for structured comparisons. Do not duplicate a generated card as a Markdown list or table.\n\n${MEMORY_SAFETY_INSTRUCTION}${memoryContext}` },
    ...history.slice(-40).map((message) => ({ role: message.role, content: message.content } as ModelMessage)),
  ];
}

async function runModel(
  env: Env,
  settings: AgentSettings,
  messages: ModelMessage[],
  signal: AbortSignal | undefined,
  onText: (delta: string) => void,
): Promise<{ response?: string; tool_calls?: ChatCompletionMessageToolCall[] }> {
  const input: ChatCompletionsMessagesInput & { stream: true } = {
    messages: toChatCompletionMessages(messages),
    tools: MODEL_TOOLS,
    max_tokens: 4_096,
    temperature: settings.thinkingLevel === "off" ? 0.3 : 0.5,
    reasoning_effort: settings.thinkingLevel === "off" ? null : settings.thinkingLevel === "high" ? "high" : settings.thinkingLevel === "low" ? "low" : "medium",
    stream: true,
    stream_options: { include_usage: true },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let started = false;
    try {
      const stream = await env.AI.run(env.EVA_CLOUD_MODEL, input, { signal });
      return await consumeChatCompletionStream(stream, (delta) => {
        started = true;
        onText(delta);
      });
    } catch (error) {
      if (started || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
  }
  throw new Error("Workers AI streaming failed.");
}

function normalizeToolCalls(value: ChatCompletionMessageToolCall[] | undefined): ModelToolCall[] {
  if (!value) return [];
  return value.flatMap((call) => {
    if (call.type !== "function") return [];
    return [{ id: call.id || crypto.randomUUID(), name: call.function.name, input: parseToolInput(call.function.arguments) }];
  });
}

function parseToolInput(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return normalizeLegacyInput(parsed);
  } catch {
    return {};
  }
}

function normalizeLegacyInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function generativeUiBlock(name: string, raw: Record<string, unknown>): UiBlock {
  const common = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  if (name === "present_plan") return uiBlockSchema.parse({ ...common, kind: "plan", ...presentPlanInputSchema.parse(raw) });
  if (name === "present_choice") return uiBlockSchema.parse({ ...common, kind: "choice", selected: [], status: "awaiting", ...presentChoiceInputSchema.parse(raw) });
  if (name === "present_table") return uiBlockSchema.parse({ ...common, kind: "table", ...presentTableInputSchema.parse(raw) });
  throw new Error(`Unknown generative UI tool ${name}.`);
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function selectedDeviceModel(device: DeviceCapability): string | undefined {
  const model = device.models.find((candidate) => candidate.available !== false);
  return model ? `${model.provider}/${model.id}` : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}
