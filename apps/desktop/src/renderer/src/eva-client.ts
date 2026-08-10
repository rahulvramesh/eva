import {
  command,
  type ClientCommand,
  type ServerEvent,
} from "../../../../../packages/protocol/src/index";

type Listener = (event: ServerEvent) => void;

export class EvaClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private closed = false;
  private listeners = new Set<Listener>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private authenticationListeners = new Set<() => void>();
  readonly runtime = configuredRuntime();

  async connect(): Promise<void> {
    const connection = this.runtime === "cloud"
      ? cloudConnection()
      : window.eva
        ? await window.eva.getConnection()
        : { url: "ws://127.0.0.1:43111/ws", token: "eva-dev-token" };
    const socket = this.runtime === "cloud"
      ? new WebSocket(connection.url, connection.token ? ["eva-v1", `eva-token.${connection.token}`] : ["eva-v1"])
      : new WebSocket(connection.token ? `${connection.url}${connection.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(connection.token)}` : connection.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.connectionListeners.forEach((listener) => listener(true));
      this.send(command("chat.list", {}));
      this.send(command("settings.get", {}));
      this.send(command("memory.list", {}));
    });
    socket.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        this.listeners.forEach((listener) => listener(event));
      } catch {
        // Ignore malformed server data; the next reconnect requests a snapshot.
      }
    });
    socket.addEventListener("close", (event) => {
      this.connectionListeners.forEach((listener) => listener(false));
      if (this.runtime === "cloud" && (event.code === 1006 || event.code === 1008)) {
        this.authenticationListeners.forEach((listener) => listener());
      }
      if (!this.closed) this.reconnectTimer = window.setTimeout(() => void this.connect(), 800);
    });
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
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Eva is reconnecting. Try again in a moment.");
    this.socket.send(JSON.stringify(value));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}

export type EvaRuntime = "local" | "cloud";

export function configuredRuntime(): EvaRuntime {
  const saved = localStorage.getItem("eva-runtime");
  if (saved === "cloud" || saved === "local") return saved;
  return window.eva || location.hostname === "127.0.0.1" || location.hostname === "localhost" ? "local" : "cloud";
}

export function saveCloudConfiguration(endpoint: string, token: string): void {
  const normalized = endpoint.trim().replace(/\/$/, "");
  if (normalized) localStorage.setItem("eva-cloud-endpoint", normalized);
  if (token.trim()) localStorage.setItem("eva-cloud-token", token.trim());
  localStorage.setItem("eva-runtime", "cloud");
}

function cloudConnection(): { url: string; token: string } {
  const endpoint = (localStorage.getItem("eva-cloud-endpoint") || location.origin).replace(/\/$/, "");
  const url = new URL(`${endpoint}/api/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { url: url.toString(), token: localStorage.getItem("eva-cloud-token") ?? "" };
}
