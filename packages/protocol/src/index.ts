import { z } from "zod";

export const PROTOCOL_VERSION = 2;
export const MAX_CONCURRENT_CHATS = 3;

export const executionHostSchema = z.enum(["cloud", "device"]);
export type ExecutionHost = z.infer<typeof executionHostSchema>;
export const routingPolicySchema = z.enum(["auto", "cloud", "device", "private"]);
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

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
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

type EventPayloads = {
  "server.hello": { protocolVersion: number; agentMode: "pi" | "fake" | "cloud" | "hybrid" };
  "chat.list": { chats: ChatSummary[] };
  "chat.created": { chat: Chat };
  "chat.snapshot": { chat: Chat };
  "message.append": { chatId: string; message: ChatMessage };
  "assistant.delta": { chatId: string; messageId: string; delta: string };
  "tool.call": { chatId: string; toolCall: ToolCall };
  "tool.update": { chatId: string; toolCall: ToolCall };
  "run.status": { chatId: string; status: "running" | "idle" | "aborted" | "error" };
  "settings.snapshot": { settings: AgentSettings };
  "settings.updated": { settings: AgentSettings };
  "memory.snapshot": { memories: Memory[] };
  "memory.updated": { memory: Memory };
  "memory.deleted": { memoryId: string };
  "device.presence": { devices: DeviceCapability[] };
  "device.turn.request": { turnId: string; chat: Chat; content: string; routing: RoutingPolicy };
  "device.turn.abort": { turnId: string; chatId: string };
  "device.settings.update": { deviceId: string; provider: string; modelId: string; thinkingLevel: ThinkingLevel; systemInstructions: string };
  "device.turn.delta": { turnId: string; chatId: string; messageId: string; delta: string };
  "device.turn.tool": { turnId: string; chatId: string; toolCall: ToolCall };
  "device.turn.complete": { turnId: string; chatId: string; messageId: string; content: string; status: "complete" | "aborted" | "error" };
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
