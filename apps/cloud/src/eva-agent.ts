import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  type AgentSettings,
  type ChatMessage,
  type ClientCommand,
  type DeviceCapability,
  type MemoryKind,
  type RoutingPolicy,
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
import { ChatRunRegistry } from "./chat-run-registry";

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
};
type PreferredDeviceModel = { deviceId: string; provider: string; modelId: string; thinkingLevel: AgentSettings["thinkingLevel"]; systemInstructions: string };

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
    const headers = protocols.includes("eva-v2") ? { "sec-websocket-protocol": "eva-v2" } : undefined;
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
        return;
      }
      case "device.turn.delta":
        await this.acceptDeviceDelta(socket, command.turnId, command.delta);
        return;
      case "device.turn.tool":
        await this.acceptDeviceTool(socket, command.turnId, command.toolCall);
        return;
      case "device.turn.complete":
        await this.acceptDeviceCompletion(socket, command.turnId, command.content, command.status);
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

  private async routePrompt(userId: string, chatId: string, content: string, routing: RoutingPolicy): Promise<void> {
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
      await this.runDevicePrompt(userId, chatId, content, routing, device, effectivePreferred);
      return;
    }
    if ((routing === "device" || routing === "private") && !device) throw new Error("Your Eva desktop device is offline.");
    await this.runPrompt(userId, chatId, content);
  }

  private async runDevicePrompt(
    userId: string,
    chatId: string,
    content: string,
    routing: RoutingPolicy,
    device: DeviceCapability,
    preferred?: PreferredDeviceModel,
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
      if (pending) await this.failDeviceTurn(pending, errorMessage(error));
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
  ): Promise<void> {
    const pending = await this.authorizeDeviceTurn(socket, turnId);
    await updateMessage(this.env.DB, pending.userId, pending.chatId, pending.assistantMessageId, { content, status });
    await this.ctx.storage.delete([`device-turn:${turnId}`, `active-device-turn:${pending.chatId}`]);
    this.runs.finish(pending.chatId);
    await this.scheduleDeviceAlarm();
    this.broadcast("device.turn.complete", {
      turnId,
      chatId: pending.chatId,
      messageId: pending.assistantMessageId,
      content,
      status,
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

      const [chat, memories] = await Promise.all([
        getChat(this.env.DB, userId, chatId),
        retrieveMemories(this.env, userId, content),
      ]);
      const messages = buildModelMessages(settings, memories, chat.messages.filter((message) => message.id !== assistant!.id));
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
        output = `Memory saved ✓ [${memory.id.slice(0, 8)}]: ${memory.content}`;
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
      this.runs.finish(approval.chatId);
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
    { role: "system", content: `${settings.systemInstructions}\n\n${MEMORY_SAFETY_INSTRUCTION}${memoryContext}` },
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
