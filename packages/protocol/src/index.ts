import { z } from "zod";

export const PROTOCOL_VERSION = 3;
export const MAX_CONCURRENT_CHATS = 3;

export const executionHostSchema = z.enum(["cloud", "device"]);
export type ExecutionHost = z.infer<typeof executionHostSchema>;
export const routingPolicySchema = z.enum(["auto", "cloud", "device", "private"]);
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

const uiBlockBaseSchema = z.object({ id: z.string().uuid(), createdAt: z.string() });
const uiReminderBlockSchema = uiBlockBaseSchema.extend({
  kind: z.literal("reminder"),
  reminderId: z.string().uuid(),
  title: z.string().min(1).max(200),
  notes: z.string().max(4_000).default(""),
  runAt: z.string(),
  timezone: z.string().min(1).max(100),
  recurrence: z.enum(["none", "daily", "weekly", "monthly"]),
  appEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  status: z.enum(["active", "paused", "completed"]),
});
const uiApprovalBlockSchema = uiBlockBaseSchema.extend({
  kind: z.literal("approval"),
  toolCallId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
});
const uiPlanBlockSchema = uiBlockBaseSchema.extend({
  kind: z.literal("plan"),
  title: z.string().min(1).max(200),
  steps: z.array(z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(500),
    status: z.enum(["pending", "running", "complete", "error"]).default("pending"),
  })).min(1).max(20),
});
const uiChoiceBlockSchema = uiBlockBaseSchema.extend({
  kind: z.literal("choice"),
  question: z.string().min(1).max(1_000),
  options: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(300), description: z.string().max(1_000).optional() })).min(2).max(10),
  allowMultiple: z.boolean().default(false),
  selected: z.array(z.string()).max(10).default([]),
  status: z.enum(["awaiting", "submitted"]).default("awaiting"),
});
const uiTableValueSchema = z.union([z.string().max(4_000), z.number(), z.boolean(), z.null()]);
const uiTableBlockSchema = uiBlockBaseSchema.extend({
  kind: z.literal("table"),
  title: z.string().max(200).optional(),
  columns: z.array(z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(200) })).min(1).max(12),
  rows: z.array(z.record(z.string(), uiTableValueSchema)).max(100),
  caption: z.string().max(1_000).optional(),
});

export const uiBlockSchema = z.discriminatedUnion("kind", [
  uiReminderBlockSchema,
  uiApprovalBlockSchema,
  uiPlanBlockSchema,
  uiChoiceBlockSchema,
  uiTableBlockSchema,
]);
export type UiBlock = z.infer<typeof uiBlockSchema>;

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  status: z.enum(["complete", "streaming", "aborted", "error"]).default("complete"),
  executionHost: executionHostSchema.optional(),
  deviceId: z.string().optional(),
  model: z.string().optional(),
  private: z.boolean().optional(),
  uiBlocks: z.array(uiBlockSchema).max(20).default([]),
});

export type ChatMessage = z.infer<typeof messageSchema>;

export const toolCallSchema = z.object({
  id: z.string(),
  assistantMessageId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.string(),
  status: z.enum(["pending", "running", "complete", "error", "rejected"]),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatSchema = chatSummarySchema.extend({
  sessionFile: z.string().optional(),
  messages: z.array(messageSchema),
  toolCalls: z.array(toolCallSchema).default([]),
});

export type Chat = z.infer<typeof chatSchema>;

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const agentModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().positive().optional(),
  thinkingLevels: z.array(thinkingLevelSchema).min(1),
  executionHost: executionHostSchema.optional(),
  deviceId: z.string().optional(),
  available: z.boolean().optional(),
  localInference: z.boolean().optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

export const deviceCapabilitySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  platform: z.string().min(1).max(50),
  workspace: z.string().max(1_000),
  models: z.array(agentModelSchema).max(500),
  tools: z.array(z.string().min(1).max(100)).max(100),
  connectedAt: z.string().optional(),
  online: z.boolean().optional(),
});
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;

export const agentSettingsSchema = z.object({
  models: z.array(agentModelSchema),
  selectedModel: z.object({ provider: z.string(), id: z.string() }),
  thinkingLevel: thinkingLevelSchema,
  systemInstructions: z.string(),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export const memoryKindSchema = z.enum(["preference", "profile", "project", "instruction", "fact"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memorySchema = z.object({
  id: z.string(),
  kind: memoryKindSchema,
  content: z.string(),
  importance: z.number().int().min(1).max(10),
  sourceChatId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type Memory = z.infer<typeof memorySchema>;

export const reminderRecurrenceSchema = z.enum(["none", "daily", "weekly", "monthly"]);
export type ReminderRecurrence = z.infer<typeof reminderRecurrenceSchema>;
export const reminderStatusSchema = z.enum(["active", "paused", "completed"]);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

export const reminderSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  runAt: z.string(),
  nextRunAt: z.string().optional(),
  timezone: z.string(),
  recurrence: reminderRecurrenceSchema,
  appEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  status: reminderStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().optional(),
});
export type Reminder = z.infer<typeof reminderSchema>;

export const backgroundTaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_device",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

export const backgroundTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  chatId: z.string(),
  sourceChatId: z.string().optional(),
  routing: routingPolicySchema,
  status: backgroundTaskStatusSchema,
  progress: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  executionHost: executionHostSchema.optional(),
  deviceId: z.string().optional(),
  model: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  reminderId: z.string().optional(),
  taskId: z.string().optional(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  readAt: z.string().optional(),
});
export type EvaNotification = z.infer<typeof notificationSchema>;

export const notificationPreferencesSchema = z.object({
  email: z.string().email().or(z.literal("")),
  appEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  timezone: z.string().min(1).max(100),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

const commandBase = z.object({
  version: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
});

export const clientCommandSchema = z.discriminatedUnion("type", [
  commandBase.extend({ type: z.literal("chat.list") }),
  commandBase.extend({ type: z.literal("chat.create") }),
  commandBase.extend({ type: z.literal("chat.open"), chatId: z.string() }),
  commandBase.extend({
    type: z.literal("message.send"),
    chatId: z.string(),
    content: z.string().trim().min(1).max(100_000),
    routing: routingPolicySchema.optional(),
  }),
  commandBase.extend({ type: z.literal("device.register"), device: deviceCapabilitySchema }),
  commandBase.extend({
    type: z.literal("device.turn.execute"),
    turnId: z.string(),
    chat: chatSchema,
    content: z.string().trim().min(1).max(100_000),
    routing: routingPolicySchema,
  }),
  commandBase.extend({ type: z.literal("device.turn.delta"), turnId: z.string(), delta: z.string().max(100_000) }),
  commandBase.extend({ type: z.literal("device.turn.abort"), turnId: z.string(), chatId: z.string() }),
  commandBase.extend({ type: z.literal("device.turn.tool"), turnId: z.string(), toolCall: toolCallSchema }),
  commandBase.extend({
    type: z.literal("device.turn.complete"),
    turnId: z.string(),
    content: z.string().max(1_000_000),
    status: z.enum(["complete", "aborted", "error"]),
    uiBlocks: z.array(uiBlockSchema).max(20).default([]),
    sessionFile: z.string().optional(),
  }),
  commandBase.extend({
    type: z.literal("sync.turn.push"),
    chatId: z.string(),
    title: z.string().min(1).max(200),
    createdAt: z.string(),
    userMessage: messageSchema,
    assistantMessage: messageSchema,
    toolCalls: z.array(toolCallSchema).max(500).default([]),
  }),
  commandBase.extend({ type: z.literal("run.abort"), chatId: z.string() }),
  commandBase.extend({ type: z.literal("tool.approve"), toolCallId: z.string() }),
  commandBase.extend({ type: z.literal("tool.reject"), toolCallId: z.string() }),
  commandBase.extend({
    type: z.literal("ui.choice.submit"),
    chatId: z.string(),
    messageId: z.string(),
    blockId: z.string().uuid(),
    selected: z.array(z.string().min(1).max(100)).min(1).max(10),
  }),
  commandBase.extend({ type: z.literal("settings.get") }),
  commandBase.extend({
    type: z.literal("settings.update"),
    provider: z.string(),
    modelId: z.string(),
    thinkingLevel: thinkingLevelSchema,
    systemInstructions: z.string().max(20_000),
  }),
  commandBase.extend({ type: z.literal("memory.list") }),
  commandBase.extend({
    type: z.literal("memory.create"),
    kind: memoryKindSchema,
    content: z.string().trim().min(1).max(2_000),
    importance: z.number().int().min(1).max(10).default(5),
  }),
  commandBase.extend({
    type: z.literal("memory.update"),
    memoryId: z.string(),
    kind: memoryKindSchema,
    content: z.string().trim().min(1).max(2_000),
    importance: z.number().int().min(1).max(10),
    status: z.enum(["active", "archived"]),
  }),
  commandBase.extend({ type: z.literal("memory.delete"), memoryId: z.string() }),
  commandBase.extend({ type: z.literal("reminder.list") }),
  commandBase.extend({
    type: z.literal("reminder.create"),
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(4_000).default(""),
    runAt: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
    recurrence: reminderRecurrenceSchema.default("none"),
    appEnabled: z.boolean().default(true),
    emailEnabled: z.boolean().default(false),
  }),
  commandBase.extend({
    type: z.literal("reminder.update"),
    reminderId: z.string(),
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(4_000),
    runAt: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
    recurrence: reminderRecurrenceSchema,
    appEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    status: reminderStatusSchema,
  }),
  commandBase.extend({ type: z.literal("reminder.delete"), reminderId: z.string() }),
  commandBase.extend({ type: z.literal("task.list") }),
  commandBase.extend({
    type: z.literal("task.create"),
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(100_000),
    routing: routingPolicySchema.default("auto"),
  }),
  commandBase.extend({ type: z.literal("task.cancel"), taskId: z.string() }),
  commandBase.extend({ type: z.literal("notification.list") }),
  commandBase.extend({ type: z.literal("notification.read"), notificationId: z.string() }),
  commandBase.extend({ type: z.literal("notification.preferences.get") }),
  commandBase.extend({
    type: z.literal("notification.preferences.update"),
    email: z.string().trim().email().or(z.literal("")),
    appEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    timezone: z.string().trim().min(1).max(100),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

type EventPayloads = {
  "server.hello": { protocolVersion: number; agentMode: "pi" | "fake" | "cloud" | "hybrid" };
  "chat.list": { chats: ChatSummary[] };
  "chat.created": { chat: Chat };
  "chat.snapshot": { chat: Chat };
  "message.append": { chatId: string; message: ChatMessage };
  "message.updated": { chatId: string; message: ChatMessage };
  "assistant.delta": { chatId: string; messageId: string; delta: string };
  "tool.call": { chatId: string; toolCall: ToolCall };
  "tool.update": { chatId: string; toolCall: ToolCall };
  "run.status": { chatId: string; status: "running" | "idle" | "aborted" | "error" };
  "settings.snapshot": { settings: AgentSettings };
  "settings.updated": { settings: AgentSettings };
  "memory.snapshot": { memories: Memory[] };
  "memory.updated": { memory: Memory };
  "memory.deleted": { memoryId: string };
  "reminder.snapshot": { reminders: Reminder[] };
  "reminder.updated": { reminder: Reminder };
  "reminder.deleted": { reminderId: string };
  "task.snapshot": { tasks: BackgroundTask[] };
  "task.updated": { task: BackgroundTask };
  "notification.snapshot": { notifications: EvaNotification[] };
  "notification.created": { notification: EvaNotification };
  "notification.read": { notificationId: string; readAt: string };
  "notification.preferences": { preferences: NotificationPreferences };
  "device.presence": { devices: DeviceCapability[] };
  "device.turn.request": { turnId: string; chat: Chat; content: string; routing: RoutingPolicy };
  "device.turn.abort": { turnId: string; chatId: string };
  "device.settings.update": { deviceId: string; provider: string; modelId: string; thinkingLevel: ThinkingLevel; systemInstructions: string };
  "device.turn.delta": { turnId: string; chatId: string; messageId: string; delta: string };
  "device.turn.tool": { turnId: string; chatId: string; toolCall: ToolCall };
  "device.turn.complete": { turnId: string; chatId: string; messageId: string; content: string; status: "complete" | "aborted" | "error"; uiBlocks: UiBlock[] };
  "route.status": { chatId: string; turnId: string; host: ExecutionHost; deviceId?: string; model?: string; private: boolean; status: "queued" | "running" | "complete" | "error" };
  "sync.turn.ack": { chatId: string; assistantMessageId: string };
  "server.error": { code: string; message: string; requestId?: string };
};

export type ServerEventType = keyof EventPayloads;
export type ServerEvent<T extends ServerEventType = ServerEventType> = {
  [K in T]: {
    version: typeof PROTOCOL_VERSION;
    sequence: number;
    type: K;
    payload: EventPayloads[K];
  };
}[T];

export function command<T extends ClientCommand["type"]>(
  type: T,
  payload: Omit<Extract<ClientCommand, { type: T }>, "type" | "version" | "requestId">,
): ClientCommand {
  return { type, version: PROTOCOL_VERSION, requestId: crypto.randomUUID(), ...payload } as ClientCommand;
}
