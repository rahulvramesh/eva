import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  type ChatMessage,
  type ClientCommand,
  type ServerEvent,
  type ServerEventType,
  type ToolCall,
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
      case "settings.get":
        this.send(socket, "settings.snapshot", { settings: await this.options.backend.getSettings() });
        return;
      case "settings.update":
        if (this.running.size > 0) throw new Error("Stop the current response before changing model settings.");
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
        if (this.running.size > 0) throw new Error("Wait for the current response or stop it first.");
        void this.runPrompt(command.chatId, command.content);
        return;
    }
  }

  private async runPrompt(chatId: string, content: string): Promise<void> {
    const userMessage = makeMessage("user", content, "complete");
    let chat = await this.options.repository.appendMessage(chatId, userMessage);
    this.broadcast("message.append", { chatId, message: userMessage });

    const assistantMessage = makeMessage("assistant", "", "streaming");
    chat = await this.options.repository.appendMessage(chatId, assistantMessage);
    this.running.set(chatId, { assistantId: assistantMessage.id, content: "" });
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
      await toolQueue;
      if (toolFailure) throw toolFailure;
      const state = this.running.get(chatId)!;
      await this.options.repository.updateMessage(chatId, state.assistantId, { content: state.content, status: "complete" });
      if (result.sessionFile && result.sessionFile !== chat.sessionFile) {
        await this.options.repository.setSessionFile(chatId, result.sessionFile);
      }
      this.broadcast("run.status", { chatId, status: "idle" });
    } catch (error) {
      await toolQueue;
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

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function makeMessage(role: ChatMessage["role"], content: string, status: ChatMessage["status"]): ChatMessage {
  return { id: randomUUID(), role, content, status, createdAt: new Date().toISOString() };
}
