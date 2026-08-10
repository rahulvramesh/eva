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

  async connect(): Promise<void> {
    const connection = window.eva
      ? await window.eva.getConnection()
      : { url: "ws://127.0.0.1:43111/ws", token: "eva-dev-token" };
    const socket = new WebSocket(`${connection.url}?token=${encodeURIComponent(connection.token)}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.connectionListeners.forEach((listener) => listener(true));
      this.send(command("chat.list", {}));
      this.send(command("settings.get", {}));
    });
    socket.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        this.listeners.forEach((listener) => listener(event));
      } catch {
        // Ignore malformed server data; the next reconnect requests a snapshot.
      }
    });
    socket.addEventListener("close", () => {
      this.connectionListeners.forEach((listener) => listener(false));
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
