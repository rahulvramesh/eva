import type {
  AgentSettings,
  Chat,
  ChatMessage,
  ChatSummary,
  Memory,
  MemoryKind,
  ThinkingLevel,
  ToolCall,
} from "../../../packages/protocol/src/index";

type ChatRow = { id: string; title: string; created_at: string; updated_at: string };
type MessageRow = {
  id: string;
  role: ChatMessage["role"];
  content: string;
  status: ChatMessage["status"];
  created_at: string;
  execution_host: ChatMessage["executionHost"] | null;
  device_id: string | null;
  model: string | null;
  private: number;
};
type ToolRow = {
  id: string;
  assistant_message_id: string;
  name: string;
  input_json: string;
  output: string;
  status: ToolCall["status"];
  created_at: string;
  completed_at: string | null;
};
type MemoryRow = {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  source_chat_id: string | null;
  source_message_id: string | null;
  status: Memory["status"];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

export type PendingApproval = {
  id: string;
  chatId: string;
  assistantMessageId: string;
  toolCallId: string;
  modelMessages: ModelMessage[];
};

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

const CLOUD_MODELS: AgentSettings["models"] = [
  {
    provider: "cloudflare",
    id: "@cf/moonshotai/kimi-k2.6",
    name: "Kimi K2.6 Cloud",
    contextWindow: 262_144,
    thinkingLevels: ["off", "low", "medium", "high"],
  },
];

export async function ensureUser(db: D1Database, userId: string, identity: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (id, identity, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).bind(userId, identity, now).run();
}

export async function listChats(db: D1Database, userId: string): Promise<ChatSummary[]> {
  const result = await db.prepare(`
    SELECT id, title, created_at, updated_at FROM chats
    WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 200
  `).bind(userId).all<ChatRow>();
  return result.results.map(toChatSummary);
}

export async function createChat(db: D1Database, userId: string): Promise<Chat> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, 'New chat', ?3, ?3)
  `).bind(id, userId, now).run();
  return { id, title: "New chat", createdAt: now, updatedAt: now, messages: [], toolCalls: [] };
}

export async function getChat(db: D1Database, userId: string, chatId: string): Promise<Chat> {
  const row = await db.prepare(`
    SELECT id, title, created_at, updated_at FROM chats WHERE id = ?1 AND user_id = ?2
  `).bind(chatId, userId).first<ChatRow>();
  if (!row) throw new Error("Chat not found.");
  const [messages, tools] = await Promise.all([
    db.prepare(`
      SELECT id, role, content, status, created_at, execution_host, device_id, model, private FROM messages
      WHERE chat_id = ?1 AND user_id = ?2 ORDER BY created_at
    `).bind(chatId, userId).all<MessageRow>(),
    db.prepare(`
      SELECT id, assistant_message_id, name, input_json, output, status, created_at, completed_at
      FROM tool_calls WHERE chat_id = ?1 AND user_id = ?2 ORDER BY created_at
    `).bind(chatId, userId).all<ToolRow>(),
  ]);
  return {
    ...toChatSummary(row),
    messages: messages.results.map(toMessage),
    toolCalls: tools.results.map(toToolCall),
  };
}

export async function appendMessage(
  db: D1Database,
  userId: string,
  chatId: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"],
  provenance: Pick<ChatMessage, "executionHost" | "deviceId" | "model" | "private"> = {},
): Promise<ChatMessage> {
  await assertChatOwner(db, userId, chatId);
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    status,
    createdAt: new Date().toISOString(),
    ...provenance,
  };
  const title = role === "user" ? titleFromPrompt(content) : null;
  await db.batch([
    db.prepare(`
      INSERT INTO messages (id, chat_id, user_id, role, content, status, created_at, execution_host, device_id, model, private)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).bind(message.id, chatId, userId, role, content, status, message.createdAt, message.executionHost ?? null, message.deviceId ?? null, message.model ?? null, message.private ? 1 : 0),
    db.prepare(`
      UPDATE chats SET updated_at = ?1,
        title = CASE WHEN title = 'New chat' AND ?2 IS NOT NULL THEN ?2 ELSE title END
      WHERE id = ?3 AND user_id = ?4
    `).bind(message.createdAt, title, chatId, userId),
  ]);
  return message;
}

export async function appendMessageWithId(
  db: D1Database,
  userId: string,
  chatId: string,
  message: ChatMessage,
): Promise<ChatMessage> {
  await assertChatOwner(db, userId, chatId);
  const title = message.role === "user" ? titleFromPrompt(message.content) : null;
  await db.batch([
    db.prepare(`
      INSERT INTO messages (id, chat_id, user_id, role, content, status, created_at, execution_host, device_id, model, private)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT(id) DO NOTHING
    `).bind(message.id, chatId, userId, message.role, message.content, message.status, message.createdAt, message.executionHost ?? null, message.deviceId ?? null, message.model ?? null, message.private ? 1 : 0),
    db.prepare(`
      UPDATE chats SET updated_at = MAX(updated_at, ?1),
        title = CASE WHEN title = 'New chat' AND ?2 IS NOT NULL THEN ?2 ELSE title END
      WHERE id = ?3 AND user_id = ?4
    `).bind(message.createdAt, title, chatId, userId),
  ]);
  return message;
}

export async function importTurn(
  db: D1Database,
  userId: string,
  input: { chatId: string; title: string; createdAt: string; userMessage: ChatMessage; assistantMessage: ChatMessage; toolCalls: ToolCall[] },
): Promise<void> {
  const updatedAt = [input.userMessage.createdAt, input.assistantMessage.createdAt].sort().at(-1) ?? input.createdAt;
  await db.prepare(`
    INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(id) DO UPDATE SET updated_at = MAX(chats.updated_at, excluded.updated_at)
    WHERE chats.user_id = excluded.user_id
  `).bind(input.chatId, userId, input.title, input.createdAt, updatedAt).run();
  await appendMessageWithId(db, userId, input.chatId, input.userMessage);
  await appendMessageWithId(db, userId, input.chatId, input.assistantMessage);
  for (const toolCall of input.toolCalls) await upsertToolCall(db, userId, input.chatId, toolCall);
}

export async function updateMessage(
  db: D1Database,
  userId: string,
  chatId: string,
  messageId: string,
  patch: Pick<ChatMessage, "content" | "status">,
): Promise<void> {
  const result = await db.prepare(`
    UPDATE messages SET content = ?1, status = ?2
    WHERE id = ?3 AND chat_id = ?4 AND user_id = ?5
  `).bind(patch.content, patch.status, messageId, chatId, userId).run();
  if (!result.meta.changes) throw new Error("Message not found.");
}

export async function getSettings(db: D1Database, env: Env, userId: string): Promise<AgentSettings> {
  const row = await db.prepare(`
    SELECT selected_model, thinking_level, system_instructions FROM settings WHERE user_id = ?1
  `).bind(userId).first<{ selected_model: string; thinking_level: ThinkingLevel; system_instructions: string }>();
  const selected = CLOUD_MODELS.find((model) => model.id === row?.selected_model) ?? CLOUD_MODELS[0]!;
  return {
    models: CLOUD_MODELS,
    selectedModel: { provider: selected.provider, id: selected.id },
    thinkingLevel: selected.thinkingLevels.includes(row?.thinking_level ?? "medium") ? row?.thinking_level ?? "medium" : "medium",
    systemInstructions: row?.system_instructions ?? env.EVA_DEFAULT_SYSTEM_INSTRUCTIONS,
  };
}

export async function updateSettings(db: D1Database, env: Env, userId: string, settings: AgentSettings): Promise<AgentSettings> {
  const model = CLOUD_MODELS.find((item) => item.id === settings.selectedModel.id && item.provider === settings.selectedModel.provider);
  if (!model) throw new Error("That cloud model is not available.");
  if (!model.thinkingLevels.includes(settings.thinkingLevel)) throw new Error("That reasoning level is not supported by the model.");
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO settings (user_id, selected_model, thinking_level, system_instructions, memory_enabled, updated_at)
    VALUES (?1, ?2, ?3, ?4, 1, ?5)
    ON CONFLICT(user_id) DO UPDATE SET selected_model = excluded.selected_model,
      thinking_level = excluded.thinking_level,
      system_instructions = excluded.system_instructions,
      updated_at = excluded.updated_at
  `).bind(userId, model.id, settings.thinkingLevel, settings.systemInstructions, now).run();
  return getSettings(db, env, userId);
}

export async function createToolCall(
  db: D1Database,
  userId: string,
  chatId: string,
  assistantMessageId: string,
  name: string,
  input: Record<string, unknown>,
  status: ToolCall["status"],
): Promise<ToolCall> {
  const toolCall: ToolCall = {
    id: crypto.randomUUID(),
    assistantMessageId,
    name,
    input,
    output: "",
    status,
    createdAt: new Date().toISOString(),
  };
  await db.prepare(`
    INSERT INTO tool_calls (id, chat_id, user_id, assistant_message_id, name, input_json, output, status, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8)
  `).bind(toolCall.id, chatId, userId, assistantMessageId, name, JSON.stringify(input), status, toolCall.createdAt).run();
  return toolCall;
}

export async function updateToolCall(
  db: D1Database,
  userId: string,
  id: string,
  status: ToolCall["status"],
  output: string,
): Promise<ToolCall> {
  const completedAt = ["complete", "error", "rejected"].includes(status) ? new Date().toISOString() : null;
  const result = await db.prepare(`
    UPDATE tool_calls SET status = ?1, output = ?2, completed_at = ?3
    WHERE id = ?4 AND user_id = ?5
  `).bind(status, output, completedAt, id, userId).run();
  if (!result.meta.changes) throw new Error("Tool call not found.");
  const row = await db.prepare(`
    SELECT id, assistant_message_id, name, input_json, output, status, created_at, completed_at
    FROM tool_calls WHERE id = ?1 AND user_id = ?2
  `).bind(id, userId).first<ToolRow>();
  if (!row) throw new Error("Tool call not found.");
  return toToolCall(row);
}

export async function upsertToolCall(
  db: D1Database,
  userId: string,
  chatId: string,
  toolCall: ToolCall,
): Promise<ToolCall> {
  await assertChatOwner(db, userId, chatId);
  await db.prepare(`
    INSERT INTO tool_calls
      (id, chat_id, user_id, assistant_message_id, name, input_json, output, status, created_at, completed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT(id) DO UPDATE SET output = excluded.output, status = excluded.status,
      completed_at = excluded.completed_at
    WHERE tool_calls.user_id = excluded.user_id
  `).bind(
    toolCall.id,
    chatId,
    userId,
    toolCall.assistantMessageId,
    toolCall.name,
    JSON.stringify(toolCall.input),
    toolCall.output,
    toolCall.status,
    toolCall.createdAt,
    toolCall.completedAt ?? null,
  ).run();
  return toolCall;
}

export async function saveApproval(
  db: D1Database,
  userId: string,
  chatId: string,
  assistantMessageId: string,
  toolCallId: string,
  modelMessages: ModelMessage[],
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO pending_approvals
      (id, user_id, chat_id, assistant_message_id, tool_call_id, model_messages_json, status, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)
  `).bind(crypto.randomUUID(), userId, chatId, assistantMessageId, toolCallId, JSON.stringify(modelMessages), now).run();
}

export async function takeApproval(db: D1Database, userId: string, toolCallId: string, status: "approved" | "rejected"): Promise<PendingApproval> {
  const row = await db.prepare(`
    SELECT id, chat_id, assistant_message_id, tool_call_id, model_messages_json
    FROM pending_approvals WHERE user_id = ?1 AND tool_call_id = ?2 AND status = 'pending'
  `).bind(userId, toolCallId).first<{
    id: string;
    chat_id: string;
    assistant_message_id: string;
    tool_call_id: string;
    model_messages_json: string;
  }>();
  if (!row) throw new Error("That approval is no longer pending.");
  await db.prepare(`
    UPDATE pending_approvals SET status = ?1, resolved_at = ?2 WHERE id = ?3 AND status = 'pending'
  `).bind(status, new Date().toISOString(), row.id).run();
  return {
    id: row.id,
    chatId: row.chat_id,
    assistantMessageId: row.assistant_message_id,
    toolCallId: row.tool_call_id,
    modelMessages: parseModelMessages(row.model_messages_json),
  };
}

export async function listMemories(db: D1Database, userId: string): Promise<Memory[]> {
  const result = await db.prepare(`
    SELECT id, kind, content, importance, source_chat_id, source_message_id, status,
      created_at, updated_at, last_used_at
    FROM memories WHERE user_id = ?1 ORDER BY status, importance DESC, updated_at DESC
  `).bind(userId).all<MemoryRow>();
  return result.results.map(toMemory);
}

export async function getMemoriesByIds(db: D1Database, userId: string, ids: string[]): Promise<Memory[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT id, kind, content, importance, source_chat_id, source_message_id, status,
      created_at, updated_at, last_used_at
    FROM memories WHERE user_id = ? AND status = 'active' AND id IN (${placeholders})
  `).bind(userId, ...ids).all<MemoryRow>();
  return result.results.map(toMemory);
}

export async function getAuthoritativeMemories(
  db: D1Database,
  userId: string,
  recentSince: string,
): Promise<Memory[]> {
  const result = await db.prepare(`
    SELECT id, kind, content, importance, source_chat_id, source_message_id, status,
      created_at, updated_at, last_used_at
    FROM memories
    WHERE user_id = ?1 AND status = 'active'
      AND (kind IN ('profile', 'preference', 'instruction') OR updated_at >= ?2)
    ORDER BY
      CASE kind
        WHEN 'instruction' THEN 0
        WHEN 'profile' THEN 1
        WHEN 'preference' THEN 2
        ELSE 3
      END,
      importance DESC,
      updated_at DESC
    LIMIT 24
  `).bind(userId, recentSince).all<MemoryRow>();
  return result.results.map(toMemory);
}

export async function touchMemories(db: D1Database, userId: string, ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return;
  const placeholders = uniqueIds.map(() => "?").join(", ");
  await db.prepare(`
    UPDATE memories SET last_used_at = ?
    WHERE user_id = ? AND status = 'active' AND id IN (${placeholders})
  `).bind(new Date().toISOString(), userId, ...uniqueIds).run();
}

export async function createMemory(
  db: D1Database,
  userId: string,
  input: { kind: MemoryKind; content: string; importance: number; sourceChatId?: string; sourceMessageId?: string },
): Promise<Memory> {
  rejectSensitiveMemory(input.content);
  const now = new Date().toISOString();
  const memory: Memory = {
    id: crypto.randomUUID(),
    kind: input.kind,
    content: input.content.trim(),
    importance: input.importance,
    sourceChatId: input.sourceChatId,
    sourceMessageId: input.sourceMessageId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await db.prepare(`
    INSERT INTO memories
      (id, user_id, kind, content, importance, source_chat_id, source_message_id, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)
  `).bind(memory.id, userId, memory.kind, memory.content, memory.importance, memory.sourceChatId ?? null, memory.sourceMessageId ?? null, now).run();
  return memory;
}

export async function updateMemory(db: D1Database, userId: string, memory: Pick<Memory, "id" | "kind" | "content" | "importance" | "status">): Promise<Memory> {
  rejectSensitiveMemory(memory.content);
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE memories SET kind = ?1, content = ?2, importance = ?3, status = ?4, updated_at = ?5
    WHERE id = ?6 AND user_id = ?7
  `).bind(memory.kind, memory.content.trim(), memory.importance, memory.status, now, memory.id, userId).run();
  if (!result.meta.changes) throw new Error("Memory not found.");
  const rows = await listMemories(db, userId);
  const updated = rows.find((item) => item.id === memory.id);
  if (!updated) throw new Error("Memory not found.");
  return updated;
}

export async function deleteMemory(db: D1Database, userId: string, memoryId: string): Promise<void> {
  const result = await db.prepare("DELETE FROM memories WHERE id = ?1 AND user_id = ?2").bind(memoryId, userId).run();
  if (!result.meta.changes) throw new Error("Memory not found.");
}

export async function audit(db: D1Database, userId: string, eventType: string, targetId?: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await db.prepare(`
    INSERT INTO audit_events (id, user_id, event_type, target_id, metadata_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(crypto.randomUUID(), userId, eventType, targetId ?? null, JSON.stringify(metadata), new Date().toISOString()).run();
}

async function assertChatOwner(db: D1Database, userId: string, chatId: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM chats WHERE id = ?1 AND user_id = ?2").bind(chatId, userId).first<{ id: string }>();
  if (!row) throw new Error("Chat not found.");
}

function toChatSummary(row: ChatRow): ChatSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    executionHost: row.execution_host ?? undefined,
    deviceId: row.device_id ?? undefined,
    model: row.model ?? undefined,
    private: Boolean(row.private),
  };
}

function toToolCall(row: ToolRow): ToolCall {
  return {
    id: row.id,
    assistantMessageId: row.assistant_message_id,
    name: row.name,
    input: safeRecord(row.input_json),
    output: row.output,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    sourceChatId: row.source_chat_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

function titleFromPrompt(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact || "New chat";
}

function safeRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseModelMessages(value: string): ModelMessage[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Stored approval context is invalid.");
  return parsed as ModelMessage[];
}

function rejectSensitiveMemory(content: string): void {
  const sensitive = /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|private[_ -]?key|secret)\s*[:=]\s*\S+/i;
  if (sensitive.test(content)) throw new Error("Eva will not store credentials or secrets in memory.");
}
