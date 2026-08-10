import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  MAX_CONCURRENT_CHATS,
  clientCommandSchema,
  uiBlockSchema,
  type ChatMessage,
  type ClientCommand,
  type ServerEvent,
  type ServerEventType,
  type ToolCall,
  type UiBlock,
} from "../../../packages/protocol/src/index.js";
import type { AgentBackend } from "./agent-backend.js";
import { ChatRepository } from "./chat-repository.js";

export type AgentServerOptions = {
  host: string;
  port: number;
  token: string;
  repository: ChatRepository;
  backend: AgentBackend;
};

export class AgentServer {
  private readonly http: HttpServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly running = new Map<string, { assistantId: string; content: string }>();
  private readonly deviceTurns = new Map<string, string>();
  private readonly reservedChats = new Set<string>();
  private sequence = 0;

  constructor(private readonly options: AgentServerOptions) {
    this.http = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      response.writeHead(404).end();
    });
    const websocket = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.http.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const validOrigin = !request.headers.origin
        || request.headers.origin === "null"
        || request.headers.origin === "file://"
        || /^(http:\/\/127\.0\.0\.1:\d+|app:\/\/eva)$/.test(request.headers.origin);
      if (url.pathname !== "/ws" || url.searchParams.get("token") !== options.token || !validOrigin) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
    });
    websocket.on("connection", (socket) => this.onConnection(socket));
  }

  async listen(): Promise<number> {
    await this.options.repository.initialize();
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
    return address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close(1001, "Server shutting down");
    await this.options.backend.dispose();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private onConnection(socket: WebSocket): void {
    this.sockets.add(socket);
    this.send(socket, "server.hello", { protocolVersion: PROTOCOL_VERSION, agentMode: this.options.backend.mode });
    socket.on("message", (data) => void this.onMessage(socket, data.toString()));
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const parsed = clientCommandSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.send(socket, "server.error", { code: "INVALID_COMMAND", message: "The command was not valid." });
      return;
    }
    const command = parsed.data;
    try {
      await this.dispatch(socket, command);
    } catch (error) {
      this.send(socket, "server.error", {
        code: "COMMAND_FAILED",
        message: error instanceof Error ? error.message : "The command failed.",
        requestId: command.requestId,
      });
    }
  }

  private async dispatch(socket: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "chat.list":
        this.send(socket, "chat.list", { chats: await this.options.repository.list() });
        return;
      case "chat.create": {
        const chat = await this.options.repository.create();
        this.broadcast("chat.created", { chat });
        return;
      }
      case "chat.open":
        this.send(socket, "chat.snapshot", { chat: await this.options.repository.get(command.chatId) });
        return;
      case "run.abort":
        await this.options.backend.abort(command.chatId);
        return;
      case "device.turn.abort":
        if (this.deviceTurns.get(command.turnId) === command.chatId) await this.options.backend.abort(command.chatId);
        return;
      case "settings.get":
        this.send(socket, "settings.snapshot", { settings: await this.options.backend.getSettings() });
        return;
      case "settings.update":
        if (this.running.size > 0 || this.deviceTurns.size > 0 || this.reservedChats.size > 0) throw new Error("Stop the current responses before changing model settings.");
        this.broadcast("settings.updated", {
          settings: await this.options.backend.updateSettings({
            provider: command.provider,
            modelId: command.modelId,
            thinkingLevel: command.thinkingLevel,
            systemInstructions: command.systemInstructions,
          }),
        });
        return;
      case "message.send":
        this.reserveChat(command.chatId);
        void this.runPrompt(command.chatId, command.content)
          .catch((error) => this.send(socket, "server.error", { code: "AGENT_ERROR", message: error instanceof Error ? error.message : "Agent failed" }))
          .finally(() => this.reservedChats.delete(command.chatId));
        return;
      case "ui.choice.submit":
        this.reserveChat(command.chatId);
        void this.submitChoice(command.chatId, command.messageId, command.blockId, command.selected)
          .catch((error) => this.send(socket, "server.error", { code: "UI_ACTION_FAILED", message: error instanceof Error ? error.message : "The choice could not be submitted." }))
          .finally(() => this.reservedChats.delete(command.chatId));
        return;
      case "device.turn.execute":
        this.reserveChat(command.chat.id);
        void this.runDeviceTurn(socket, command.turnId, command.chat, command.content)
          .catch((error) => this.send(socket, "server.error", { code: "AGENT_ERROR", message: error instanceof Error ? error.message : "Agent failed" }))
          .finally(() => this.reservedChats.delete(command.chat.id));
        return;
    }
  }

  private reserveChat(chatId: string): void {
    const activeChats = new Set([...this.running.keys(), ...this.deviceTurns.values(), ...this.reservedChats]);
    if (activeChats.has(chatId)) throw new Error("Wait for this chat's current response or stop it first.");
    if (activeChats.size >= MAX_CONCURRENT_CHATS) throw new Error(`Eva can run up to ${MAX_CONCURRENT_CHATS} chats at once.`);
    this.reservedChats.add(chatId);
  }

  private async submitChoice(chatId: string, messageId: string, blockId: string, selected: string[]): Promise<void> {
    const chat = await this.options.repository.get(chatId);
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    const block = message?.uiBlocks.find((candidate) => candidate.id === blockId && candidate.kind === "choice");
    if (!message || !block || block.kind !== "choice" || block.status === "submitted") throw new Error("That choice is no longer available.");
    const allowed = new Set(block.options.map((option) => option.id));
    if (selected.some((id) => !allowed.has(id)) || (!block.allowMultiple && selected.length !== 1)) throw new Error("The selected option was not valid.");
    const updatedChat = await this.options.repository.updateMessage(chatId, messageId, {
      uiBlocks: message.uiBlocks.map((candidate) => candidate.id === blockId ? { ...block, selected, status: "submitted" as const } : candidate),
    });
    this.broadcast("message.updated", { chatId, message: updatedChat.messages.find((candidate) => candidate.id === messageId)! });
    const labels = block.options.filter((option) => selected.includes(option.id)).map((option) => option.label);
    await this.runPrompt(chatId, `I selected: ${labels.join(", ")}. Continue based on this choice.`);
  }

  private async runDeviceTurn(socket: WebSocket, turnId: string, chat: Parameters<AgentBackend["generate"]>[0], prompt: string): Promise<void> {
    const assistant = [...chat.messages].reverse().find((message) => message.role === "assistant" && message.status === "streaming");
    if (!assistant) throw new Error("The hybrid turn is missing its assistant message.");
    this.deviceTurns.set(turnId, chat.id);
    this.reservedChats.delete(chat.id);
    let content = "";
    let toolQueue = Promise.resolve();
    const toolCalls = new Map<string, ToolCall>();
    const uiBlocks: UiBlock[] = [];
    try {
      const result = await this.options.backend.generate(chat, prompt, (delta) => {
        content += delta;
        this.send(socket, "device.turn.delta", { turnId, chatId: chat.id, messageId: assistant.id, delta });
      }, (activity) => {
        toolQueue = toolQueue.then(async () => {
          if (activity.phase === "start") {
            const uiBlock = uiBlockFromTool(activity.name, activity.input);
            if (uiBlock) {
              uiBlocks.push(uiBlock);
              return;
            }
            const toolCall: ToolCall = {
              id: activity.id,
              assistantMessageId: assistant.id,
              name: activity.name,
              input: activity.input,
              output: "",
              status: "running",
              createdAt: new Date().toISOString(),
            };
            toolCalls.set(toolCall.id, toolCall);
            this.send(socket, "device.turn.tool", { turnId, chatId: chat.id, toolCall });
            return;
          }
          const current = toolCalls.get(activity.id);
          if (!current) return;
          const updated: ToolCall = {
            ...current,
            output: activity.output,
            status: activity.phase === "end" ? activity.isError ? "error" : "complete" : "running",
            completedAt: activity.phase === "end" ? new Date().toISOString() : undefined,
          };
          toolCalls.set(updated.id, updated);
          this.send(socket, "device.turn.tool", { turnId, chatId: chat.id, toolCall: updated });
        });
      });
      await drainQueue(() => toolQueue);
      for (const toolCall of toolCalls.values()) {
        if (toolCall.status !== "running") continue;
        const completed = { ...toolCall, status: "complete" as const, completedAt: new Date().toISOString() };
        toolCalls.set(completed.id, completed);
        this.send(socket, "device.turn.tool", { turnId, chatId: chat.id, toolCall: completed });
      }
      if (result.sessionFile) chat.sessionFile = result.sessionFile;
      this.send(socket, "device.turn.complete", { turnId, chatId: chat.id, messageId: assistant.id, content, status: "complete", uiBlocks });
    } catch (error) {
      const aborted = error instanceof Error && (error.message === "ABORTED" || /abort/i.test(error.message));
      this.send(socket, "device.turn.complete", {
        turnId,
        chatId: chat.id,
        messageId: assistant.id,
        content: content || (aborted ? "Stopped." : error instanceof Error ? error.message : "The local turn failed."),
        status: aborted ? "aborted" : "error",
        uiBlocks,
      });
    } finally {
      this.deviceTurns.delete(turnId);
    }
  }

  private async runPrompt(chatId: string, content: string): Promise<void> {
    const userMessage = makeMessage("user", content, "complete");
    let chat = await this.options.repository.appendMessage(chatId, userMessage);
    this.broadcast("message.append", { chatId, message: userMessage });

    const assistantMessage = makeMessage("assistant", "", "streaming");
    chat = await this.options.repository.appendMessage(chatId, assistantMessage);
    this.running.set(chatId, { assistantId: assistantMessage.id, content: "" });
    this.reservedChats.delete(chatId);
    this.broadcast("message.append", { chatId, message: assistantMessage });
    this.broadcast("run.status", { chatId, status: "running" });

    let toolQueue = Promise.resolve();
    let toolFailure: unknown;
    const toolCalls = new Map<string, ToolCall>();
    try {
      const result = await this.options.backend.generate(chat, content, (delta) => {
        const state = this.running.get(chatId);
        if (!state) return;
        state.content += delta;
        this.broadcast("assistant.delta", { chatId, messageId: state.assistantId, delta });
      }, (activity) => {
        toolQueue = toolQueue.then(async () => {
          const state = this.running.get(chatId);
          if (!state) return;
          if (activity.phase === "start") {
            const uiBlock = uiBlockFromTool(activity.name, activity.input);
            if (uiBlock) {
              const currentChat = await this.options.repository.get(chatId);
              const assistant = currentChat.messages.find((message) => message.id === state.assistantId)!;
              const updatedChat = await this.options.repository.updateMessage(chatId, state.assistantId, { uiBlocks: [...assistant.uiBlocks, uiBlock] });
              this.broadcast("message.updated", { chatId, message: updatedChat.messages.find((message) => message.id === state.assistantId)! });
              return;
            }
            const toolCall: ToolCall = {
              id: activity.id,
              assistantMessageId: state.assistantId,
              name: activity.name,
              input: activity.input,
              output: "",
              status: "running",
              createdAt: new Date().toISOString(),
            };
            toolCalls.set(toolCall.id, toolCall);
            await this.options.repository.appendToolCall(chatId, toolCall);
            this.broadcast("tool.call", { chatId, toolCall });
            return;
          }
          const current = toolCalls.get(activity.id);
          if (!current) return;
          const updated = await this.options.repository.updateToolCall(chatId, activity.id, {
            output: activity.output,
            status: activity.phase === "end" ? activity.isError ? "error" : "complete" : "running",
            completedAt: activity.phase === "end" ? new Date().toISOString() : undefined,
          });
          toolCalls.set(updated.id, updated);
          this.broadcast("tool.update", { chatId, toolCall: updated });
        }).catch((error) => { toolFailure = error; });
      });
      await drainQueue(() => toolQueue);
      if (toolFailure) throw toolFailure;
      for (const toolCall of toolCalls.values()) {
        if (toolCall.status !== "running") continue;
        const completed = await this.options.repository.updateToolCall(chatId, toolCall.id, {
          status: "complete",
          completedAt: new Date().toISOString(),
        });
        toolCalls.set(completed.id, completed);
        this.broadcast("tool.update", { chatId, toolCall: completed });
      }
      const state = this.running.get(chatId)!;
      await this.options.repository.updateMessage(chatId, state.assistantId, { content: state.content, status: "complete" });
      if (result.sessionFile && result.sessionFile !== chat.sessionFile) {
        await this.options.repository.setSessionFile(chatId, result.sessionFile);
      }
      this.broadcast("run.status", { chatId, status: "idle" });
    } catch (error) {
      await drainQueue(() => toolQueue);
      const state = this.running.get(chatId);
      if (!state) return;
      const aborted = error instanceof Error && (error.message === "ABORTED" || /abort/i.test(error.message));
      const fallback = aborted ? state.content : state.content || "I couldn’t complete that response.";
      await this.options.repository.updateMessage(chatId, state.assistantId, {
        content: fallback,
        status: aborted ? "aborted" : "error",
      });
      this.broadcast("run.status", { chatId, status: aborted ? "aborted" : "error" });
      if (!aborted) {
        this.broadcast("server.error", { code: "AGENT_ERROR", message: error instanceof Error ? error.message : "Agent failed" });
      }
    } finally {
      this.running.delete(chatId);
      this.broadcast("chat.list", { chats: await this.options.repository.list() });
    }
  }

  private send<T extends ServerEventType>(socket: WebSocket, type: T, payload: Extract<ServerEvent<T>, { type: T }>["payload"]): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ version: PROTOCOL_VERSION, sequence: ++this.sequence, type, payload }));
  }

  private broadcast<T extends ServerEventType>(type: T, payload: Extract<ServerEvent<T>, { type: T }>["payload"]): void {
    for (const socket of this.sockets) this.send(socket, type, payload);
  }
}

async function drainQueue(currentQueue: () => Promise<void>): Promise<void> {
  for (;;) {
    const current = currentQueue();
    await current;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (current === currentQueue()) return;
  }
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function makeMessage(role: ChatMessage["role"], content: string, status: ChatMessage["status"]): ChatMessage {
  return { id: randomUUID(), role, content, status, createdAt: new Date().toISOString(), uiBlocks: [] };
}

function uiBlockFromTool(name: string, input: Record<string, unknown>): UiBlock | undefined {
  const common = { id: randomUUID(), createdAt: new Date().toISOString() };
  const candidate = name === "present_plan" ? { ...common, kind: "plan", ...input }
    : name === "present_choice" ? { ...common, kind: "choice", selected: [], status: "awaiting", ...input }
      : name === "present_table" ? { ...common, kind: "table", ...input }
        : undefined;
  if (!candidate) return undefined;
  const parsed = uiBlockSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`Invalid ${name} payload: ${parsed.error.issues[0]?.message ?? "invalid UI block"}`);
  return parsed.data;
}
