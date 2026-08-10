import {
  command,
  type AgentSettings,
  type Chat,
  type ClientCommand,
  type DeviceCapability,
  type ServerEvent,
} from "../../../../../packages/protocol/src/index";
import { acknowledgeTurn, addTurnIdempotently, offlineTurnFromChat, type OutboxTurn } from "./offline-outbox";

type Listener = (event: ServerEvent) => void;
type ConnectionInfo = { url: string; token: string };
type DeviceInfo = { id: string; name: string; platform: string; workspace: string };
const OUTBOX_KEY = "eva-hybrid-outbox-v1";

export class EvaClient {
  private cloudSocket?: WebSocket;
  private localSocket?: WebSocket;
  private cloudReconnectTimer?: number;
  private localReconnectTimer?: number;
  private closed = false;
  private listeners = new Set<Listener>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private authenticationListeners = new Set<() => void>();
  private localSettings?: AgentSettings;
  private deviceInfo?: DeviceInfo;
  private pendingOfflineChats = new Set<string>();
  private activeDeviceTurns = new Map<string, string>();
  private everCloudConnected = false;
  private cloudConfiguration?: { endpoint: string; token: string };
  private cloudConnected = false;
  private localConnected = false;

  async connect(): Promise<void> {
    if (window.eva) {
      this.deviceInfo = await window.eva.getDeviceInfo();
      await this.connectLocal();
      this.cloudConfiguration = await window.eva.getCloudConfiguration();
      if (!this.cloudConfiguration) {
        const legacyEndpoint = localStorage.getItem("eva-cloud-endpoint");
        const legacyToken = localStorage.getItem("eva-cloud-token");
        if (legacyEndpoint && legacyToken) {
          await window.eva.saveCloudConfiguration(legacyEndpoint, legacyToken);
          this.cloudConfiguration = { endpoint: legacyEndpoint, token: legacyToken };
          localStorage.removeItem("eva-cloud-token");
          localStorage.removeItem("eva-cloud-endpoint");
        }
      }
      if (this.cloudConfiguration) await this.connectCloud();
      else queueMicrotask(() => this.authenticationListeners.forEach((listener) => listener()));
      return;
    }
    await this.connectCloud();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onAuthenticationRequired(listener: () => void): () => void {
    this.authenticationListeners.add(listener);
    return () => this.authenticationListeners.delete(listener);
  }

  send(value: ClientCommand): void {
    if (this.cloudSocket?.readyState === WebSocket.OPEN) {
      this.cloudSocket.send(JSON.stringify(value));
      return;
    }
    if (this.localSocket?.readyState === WebSocket.OPEN) {
      if (value.type === "message.send") this.pendingOfflineChats.add(value.chatId);
      this.localSocket.send(JSON.stringify(value));
      return;
    }
    throw new Error("Eva is reconnecting. Try again in a moment.");
  }

  close(): void {
    this.closed = true;
    if (this.cloudReconnectTimer) clearTimeout(this.cloudReconnectTimer);
    if (this.localReconnectTimer) clearTimeout(this.localReconnectTimer);
    this.cloudSocket?.close();
    this.localSocket?.close();
  }

  private async connectCloud(): Promise<void> {
    if (this.closed) return;
    const connection = cloudConnection(this.cloudConfiguration);
    const socket = new WebSocket(connection.url, connection.token ? ["eva-v2", `eva-token.${connection.token}`] : ["eva-v2"]);
    this.cloudSocket = socket;
    socket.addEventListener("open", () => {
      this.cloudConnected = true;
      this.everCloudConnected = true;
      this.emitConnection();
      this.sendCloud(command("chat.list", {}));
      this.sendCloud(command("settings.get", {}));
      this.sendCloud(command("memory.list", {}));
      this.registerDevice();
      this.flushOutbox();
    });
    socket.addEventListener("message", (message) => {
      const event = parseEvent(message.data);
      if (!event) return;
      void this.handleCloudEvent(event);
    });
    socket.addEventListener("close", (event) => {
      this.cloudConnected = false;
      for (const [turnId, chatId] of this.activeDeviceTurns) this.sendLocal(command("device.turn.abort", { turnId, chatId }));
      this.activeDeviceTurns.clear();
      this.emitConnection();
      if (event.code === 1008 || (!this.everCloudConnected && event.code === 1006)) this.authenticationListeners.forEach((listener) => listener());
      if (!this.closed) this.cloudReconnectTimer = window.setTimeout(() => void this.connectCloud(), 1_200);
    });
  }

  private async connectLocal(): Promise<void> {
    if (this.closed || !window.eva) return;
    const connection = await window.eva.getConnection();
    const url = `${connection.url}${connection.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(connection.token)}`;
    const socket = new WebSocket(url);
    this.localSocket = socket;
    socket.addEventListener("open", () => {
      this.localConnected = true;
      this.emitConnection();
      this.sendLocal(command("settings.get", {}));
      if (!this.cloudConnected) {
        this.sendLocal(command("chat.list", {}));
        this.sendLocal(command("memory.list", {}));
      }
    });
    socket.addEventListener("message", (message) => {
      const event = parseEvent(message.data);
      if (!event) return;
      this.handleLocalEvent(event);
    });
    socket.addEventListener("close", () => {
      this.localConnected = false;
      this.emitConnection();
      if (!this.closed) this.localReconnectTimer = window.setTimeout(() => void this.connectLocal(), 1_000);
    });
  }

  private async handleCloudEvent(event: ServerEvent): Promise<void> {
    if (event.type === "device.turn.request") {
      if (!this.localConnected) return;
      this.activeDeviceTurns.set(event.payload.turnId, event.payload.chat.id);
      this.sendLocal(command("device.turn.execute", event.payload));
      return;
    }
    if (event.type === "device.turn.abort") {
      if (this.localConnected) this.sendLocal(command("device.turn.abort", event.payload));
      return;
    }
    if (event.type === "device.settings.update" && event.payload.deviceId === this.deviceInfo?.id) {
      this.sendLocal(command("settings.update", {
        provider: event.payload.provider,
        modelId: event.payload.modelId,
        thinkingLevel: event.payload.thinkingLevel,
        systemInstructions: event.payload.systemInstructions,
      }));
      return;
    }
    if (event.type === "sync.turn.ack") {
      writeOutbox(acknowledgeTurn(readOutbox(), event.payload.assistantMessageId));
    }
    this.listeners.forEach((listener) => listener(event));
  }

  private handleLocalEvent(event: ServerEvent): void {
    if (event.type === "settings.snapshot" || event.type === "settings.updated") {
      this.localSettings = event.payload.settings;
      this.registerDevice();
      if (!this.cloudConnected) this.listeners.forEach((listener) => listener(event));
      return;
    }
    if (event.type === "device.turn.delta") {
      this.sendCloud(command("device.turn.delta", { turnId: event.payload.turnId, delta: event.payload.delta }));
      return;
    }
    if (event.type === "device.turn.tool") {
      this.sendCloud(command("device.turn.tool", { turnId: event.payload.turnId, toolCall: event.payload.toolCall }));
      return;
    }
    if (event.type === "device.turn.complete") {
      this.activeDeviceTurns.delete(event.payload.turnId);
      this.sendCloud(command("device.turn.complete", {
        turnId: event.payload.turnId,
        content: event.payload.content,
        status: event.payload.status,
      }));
      return;
    }
    if (!this.cloudConnected) {
      this.listeners.forEach((listener) => listener(event));
      if (event.type === "run.status" && event.payload.status === "idle" && this.pendingOfflineChats.has(event.payload.chatId)) {
        this.sendLocal(command("chat.open", { chatId: event.payload.chatId }));
      }
      if (event.type === "chat.snapshot" && this.pendingOfflineChats.delete(event.payload.chat.id)) this.captureOfflineTurn(event.payload.chat);
    }
  }

  private registerDevice(): void {
    if (!this.deviceInfo || !this.localSettings || this.cloudSocket?.readyState !== WebSocket.OPEN) return;
    const device: DeviceCapability = {
      ...this.deviceInfo,
      models: this.localSettings.models.map((model) => ({ ...model, executionHost: "device", deviceId: this.deviceInfo!.id, available: true })),
      tools: ["bash", "web_fetch", "read", "grep", "find", "ls"],
    };
    this.sendCloud(command("device.register", { device }));
  }

  private captureOfflineTurn(chat: Chat): void {
    const turn = offlineTurnFromChat(chat, localStorage.getItem("eva-sync-offline-tool-output") === "true");
    if (turn) writeOutbox(addTurnIdempotently(readOutbox(), turn));
  }

  private flushOutbox(): void {
    for (const turn of readOutbox()) this.sendCloud(command("sync.turn.push", turn));
  }

  private sendCloud(value: ClientCommand): void {
    if (this.cloudSocket?.readyState === WebSocket.OPEN) this.cloudSocket.send(JSON.stringify(value));
  }

  private sendLocal(value: ClientCommand): void {
    if (this.localSocket?.readyState === WebSocket.OPEN) this.localSocket.send(JSON.stringify(value));
  }

  private emitConnection(): void {
    const connected = this.cloudConnected || this.localConnected;
    this.connectionListeners.forEach((listener) => listener(connected));
  }
}

export async function saveCloudConfiguration(endpoint: string, token: string): Promise<void> {
  const normalized = endpoint.trim().replace(/\/$/, "");
  if (window.eva) {
    await window.eva.saveCloudConfiguration(normalized, token.trim());
    return;
  }
  if (normalized) localStorage.setItem("eva-cloud-endpoint", normalized);
  if (token.trim()) localStorage.setItem("eva-cloud-token", token.trim());
}

export function hasCloudConfiguration(): boolean {
  return Boolean(localStorage.getItem("eva-cloud-token") && localStorage.getItem("eva-cloud-endpoint"));
}

function cloudConnection(configuration?: { endpoint: string; token: string }): ConnectionInfo {
  const endpoint = (configuration?.endpoint || localStorage.getItem("eva-cloud-endpoint") || location.origin).replace(/\/$/, "");
  const url = new URL(`${endpoint}/api/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { url: url.toString(), token: configuration?.token || localStorage.getItem("eva-cloud-token") || "" };
}

function parseEvent(value: unknown): ServerEvent | undefined {
  try { return JSON.parse(String(value)) as ServerEvent; } catch { return undefined; }
}

function readOutbox(): OutboxTurn[] {
  try {
    const value = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]") as unknown;
    return Array.isArray(value) ? value as OutboxTurn[] : [];
  } catch {
    return [];
  }
}

function writeOutbox(turns: OutboxTurn[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(turns));
}
