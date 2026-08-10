import { MAX_CONCURRENT_CHATS } from "../../../packages/protocol/src/index";

export class ChatRunRegistry {
  private readonly active = new Set<string>();
  private readonly aborted = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly limit = MAX_CONCURRENT_CHATS) {}

  start(chatId: string, externallyActive: Iterable<string> = []): void {
    const allActive = new Set([...this.active, ...externallyActive]);
    if (allActive.has(chatId)) throw new Error("Wait for this chat's current response or stop it first.");
    if (allActive.size >= this.limit) throw new Error(`Eva can run up to ${this.limit} chats at once.`);
    this.active.add(chatId);
    this.aborted.delete(chatId);
    this.controllers.set(chatId, new AbortController());
  }

  finish(chatId: string): void {
    this.active.delete(chatId);
    this.aborted.delete(chatId);
    this.controllers.delete(chatId);
  }

  requestAbort(chatId: string): void {
    if (this.active.has(chatId)) {
      this.aborted.add(chatId);
      this.controllers.get(chatId)?.abort();
    }
  }

  isAborted(chatId: string): boolean {
    return this.aborted.has(chatId);
  }

  signal(chatId: string): AbortSignal | undefined {
    return this.controllers.get(chatId)?.signal;
  }

  hasActive(): boolean {
    return this.active.size > 0;
  }

  activeChatIds(): string[] {
    return [...this.active];
  }
}
