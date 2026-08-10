import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  type AgentSettings,
  type ChatMessage,
  type ClientCommand,
  type MemoryKind,
  type ServerEvent,
  type ServerEventType,
  type ToolCall,
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
  getSettings,
  listChats,
  listMemories,
  saveApproval,
  takeApproval,
  updateMemory,
  updateMessage,
  updateSettings,
  updateToolCall,
  type ModelMessage,
} from "./db";
import { enqueueMemory, enqueueMemoryDelete, retrieveMemories } from "./memory";
import { runBash, runWebFetch } from "./tools";

type SocketAttachment = { userId: string; identity: string };
type ModelToolCall = { id: string; name: string; input: Record<string, unknown> };

const bashInputSchema = z.object({ command: z.string().trim().min(1).max(20_000) });
const webFetchInputSchema = z.object({ url: z.string().trim().min(1).max(8_000) });
const rememberInputSchema = z.object({
  kind: z.enum(["preference", "profile", "project", "instruction", "fact"]),
  content: z.string().trim().min(1).max(2_000),
  importance: z.number().int().min(1).max(10).default(5),
});

const MODEL_TOOLS = [
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
] satisfies ChatCompletionTool[];

export class EvaAgent extends DurableObject<Env> {
  private sequence = 0;
  private running = false;
  private abortRequested = false;

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
    this.send(server, "server.hello", { protocolVersion: PROTOCOL_VERSION, agentMode: "cloud" });
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
    const headers = protocols.includes("eva-v1") ? { "sec-websocket-protocol": "eva-v1" } : undefined;
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
        this.send(socket, "settings.snapshot", { settings: await getSettings(this.env.DB, this.env, userId) });
        return;
      case "settings.update": {
        if (this.running) throw new Error("Stop the current response before changing model settings.");
        const current = await getSettings(this.env.DB, this.env, userId);
        const settings = await updateSettings(this.env.DB, this.env, userId, {
          ...current,
          selectedModel: { provider: command.provider, id: command.modelId },
          thinkingLevel: command.thinkingLevel,
          systemInstructions: command.systemInstructions,
        });
        this.broadcast("settings.updated", { settings });
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
      case "run.abort":
        this.abortRequested = true;
        return;
      case "tool.approve":
        await this.approveTool(userId, command.toolCallId);
        return;
      case "tool.reject":
        await this.rejectTool(userId, command.toolCallId);
        return;
      case "message.send":
        if (this.running) throw new Error("Wait for the current response or stop it first.");
        this.ctx.waitUntil(this.runPrompt(userId, command.chatId, command.content));
        return;
    }
  }

  private async runPrompt(userId: string, chatId: string, content: string): Promise<void> {
    this.running = true;
    this.abortRequested = false;
    let assistant: ChatMessage | undefined;
    try {
      const userMessage = await appendMessage(this.env.DB, userId, chatId, "user", content, "complete");
      this.broadcast("message.append", { chatId, message: userMessage });
      assistant = await appendMessage(this.env.DB, userId, chatId, "assistant", "", "streaming");
      this.broadcast("message.append", { chatId, message: assistant });
      this.broadcast("run.status", { chatId, status: "running" });

      const [chat, settings, memories] = await Promise.all([
        getChat(this.env.DB, userId, chatId),
        getSettings(this.env.DB, this.env, userId),
        retrieveMemories(this.env, userId, content),
      ]);
      const messages = buildModelMessages(settings, memories, chat.messages.filter((message) => message.id !== assistant!.id));
      await this.continueTurn(userId, chatId, assistant.id, messages, "");
    } catch (error) {
      if (assistant) {
        const message = this.abortRequested ? "Stopped." : `I couldn’t complete that response: ${errorMessage(error)}`;
        await updateMessage(this.env.DB, userId, chatId, assistant.id, { content: message, status: this.abortRequested ? "aborted" : "error" });
        this.broadcast("assistant.delta", { chatId, messageId: assistant.id, delta: message });
      }
      this.broadcast("run.status", { chatId, status: this.abortRequested ? "aborted" : "error" });
      if (!this.abortRequested) this.broadcast("server.error", { code: "AGENT_ERROR", message: errorMessage(error) });
    } finally {
      this.running = false;
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
    for (let iteration = 0; iteration < 5; iteration += 1) {
      if (this.abortRequested) throw new Error("ABORTED");
      const settings = await getSettings(this.env.DB, this.env, userId);
      const result = await runModel(this.env, settings, messages);
      if (result.response) {
        content += result.response;
        this.streamText(chatId, assistantMessageId, result.response);
      }
      const toolCalls = normalizeToolCalls(result.tool_calls);
      if (!toolCalls.length) {
        const finalContent = content || "I couldn’t produce a response.";
        await updateMessage(this.env.DB, userId, chatId, assistantMessageId, { content: finalContent, status: "complete" });
        this.broadcast("run.status", { chatId, status: "idle" });
        return;
      }

      for (const request of toolCalls) {
        messages.push({ role: "assistant", content: `Requested tool ${request.name} with ${JSON.stringify(request.input)}.` });
        const needsApproval = request.name === "bash";
        const toolCall = await createToolCall(
          this.env.DB,
          userId,
          chatId,
          assistantMessageId,
          request.name,
          request.input,
          needsApproval ? "pending" : "running",
        );
        this.broadcast("tool.call", { chatId, toolCall });

        if (needsApproval) {
          await saveApproval(this.env.DB, userId, chatId, assistantMessageId, toolCall.id, messages);
          await updateMessage(this.env.DB, userId, chatId, assistantMessageId, { content, status: "complete" });
          await audit(this.env.DB, userId, "tool.approval.requested", toolCall.id, { tool: "bash" });
          this.broadcast("run.status", { chatId, status: "idle" });
          return;
        }

        const output = await this.executeAutomaticTool(userId, chatId, assistantMessageId, request, toolCall);
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
      if (request.name === "web_fetch") {
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
        output = `Saved memory: ${memory.content}`;
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

  private async approveTool(userId: string, toolCallId: string): Promise<void> {
    if (this.running) throw new Error("Eva is already running.");
    const approval = await takeApproval(this.env.DB, userId, toolCallId, "approved");
    this.running = true;
    this.abortRequested = false;
    this.broadcast("run.status", { chatId: approval.chatId, status: "running" });
    try {
      let toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "running", "");
      this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
      const command = bashInputSchema.parse(toolCall.input).command;
      const output = await runBash(this.env, userId, command);
      toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "complete", output);
      this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
      await audit(this.env.DB, userId, "tool.approved", toolCallId, { tool: "bash" });
      const chat = await getChat(this.env.DB, userId, approval.chatId);
      const assistant = chat.messages.find((message) => message.id === approval.assistantMessageId);
      approval.modelMessages.push({ role: "tool", content: output, tool_call_id: toolCallId });
      await this.continueTurn(userId, approval.chatId, approval.assistantMessageId, approval.modelMessages, assistant?.content ?? "");
    } catch (error) {
      const output = errorMessage(error);
      const toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "error", output);
      this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
      this.broadcast("server.error", { code: "TOOL_FAILED", message: output });
      this.broadcast("run.status", { chatId: approval.chatId, status: "error" });
    } finally {
      this.running = false;
    }
  }

  private async rejectTool(userId: string, toolCallId: string): Promise<void> {
    const approval = await takeApproval(this.env.DB, userId, toolCallId, "rejected");
    const toolCall = await updateToolCall(this.env.DB, userId, toolCallId, "rejected", "Rejected by the user.");
    this.broadcast("tool.update", { chatId: approval.chatId, toolCall });
    await audit(this.env.DB, userId, "tool.rejected", toolCallId, { tool: "bash" });
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
}

function buildModelMessages(settings: AgentSettings, memories: Awaited<ReturnType<typeof retrieveMemories>>, history: ChatMessage[]): ModelMessage[] {
  const memoryContext = memories.length
    ? `\n\nRelevant long-term memories:\n${memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n")}`
    : "";
  return [
    { role: "system", content: `${settings.systemInstructions}${memoryContext}` },
    ...history.slice(-40).map((message) => ({ role: message.role, content: message.content } as ModelMessage)),
  ];
}

async function runModel(env: Env, settings: AgentSettings, messages: ModelMessage[]): Promise<{ response?: string; tool_calls?: ChatCompletionMessageToolCall[] }> {
  const input: ChatCompletionsMessagesInput = {
    messages: messages.map((message): ChatCompletionMessageParam => {
      if (message.role === "system") return { role: "system", content: message.content ?? "" };
      if (message.role === "assistant") return { role: "assistant", content: message.content ?? "" };
      if (message.role === "tool") return { role: "tool", content: message.content ?? "", tool_call_id: message.tool_call_id ?? "tool" };
      return { role: "user", content: message.content ?? "" };
    }),
    tools: MODEL_TOOLS,
    max_tokens: 4_096,
    temperature: settings.thinkingLevel === "off" ? 0.3 : 0.5,
    reasoning_effort: settings.thinkingLevel === "off" ? null : settings.thinkingLevel === "high" ? "high" : settings.thinkingLevel === "low" ? "low" : "medium",
  };
  const output = await withModelRetry(() => env.AI.run(env.EVA_CLOUD_MODEL, input));
  const message = output.choices[0]?.message;
  return { response: message?.content ?? undefined, tool_calls: message?.tool_calls };
}

async function withModelRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
  }
  throw lastError;
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

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}
