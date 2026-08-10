import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  status: z.enum(["complete", "streaming", "aborted", "error"]).default("complete"),
});

export type ChatMessage = z.infer<typeof messageSchema>;

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
});
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentSettingsSchema = z.object({
  models: z.array(agentModelSchema),
  selectedModel: z.object({ provider: z.string(), id: z.string() }),
  thinkingLevel: thinkingLevelSchema,
  systemInstructions: z.string(),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

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
  }),
  commandBase.extend({ type: z.literal("run.abort"), chatId: z.string() }),
  commandBase.extend({ type: z.literal("settings.get") }),
  commandBase.extend({
    type: z.literal("settings.update"),
    provider: z.string(),
    modelId: z.string(),
    thinkingLevel: thinkingLevelSchema,
    systemInstructions: z.string().max(20_000),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

type EventPayloads = {
  "server.hello": { protocolVersion: number; agentMode: "pi" | "fake" };
  "chat.list": { chats: ChatSummary[] };
  "chat.created": { chat: Chat };
  "chat.snapshot": { chat: Chat };
  "message.append": { chatId: string; message: ChatMessage };
  "assistant.delta": { chatId: string; messageId: string; delta: string };
  "run.status": { chatId: string; status: "running" | "idle" | "aborted" | "error" };
  "settings.snapshot": { settings: AgentSettings };
  "settings.updated": { settings: AgentSettings };
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
