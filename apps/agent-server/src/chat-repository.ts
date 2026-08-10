import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Chat, ChatMessage, ChatSummary } from "../../../packages/protocol/src/index.js";

type ChatIndex = { version: 1; chats: ChatSummary[] };

export class ChatRepository {
  private readonly chatsDir: string;
  private readonly indexPath: string;

  constructor(private readonly dataDir: string) {
    this.chatsDir = join(dataDir, "chats");
    this.indexPath = join(this.chatsDir, "index.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.chatsDir, { recursive: true });
    try {
      await readFile(this.indexPath, "utf8");
    } catch {
      await this.atomicWrite(this.indexPath, { version: 1, chats: [] } satisfies ChatIndex);
    }
  }

  async list(): Promise<ChatSummary[]> {
    const index = await this.readIndex();
    return [...index.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(): Promise<Chat> {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this.atomicWrite(this.chatPath(chat.id), chat);
    const index = await this.readIndex();
    index.chats.unshift(this.toSummary(chat));
    await this.writeIndex(index);
    return chat;
  }

  async get(id: string): Promise<Chat> {
    return JSON.parse(await readFile(this.chatPath(id), "utf8")) as Chat;
  }

  async appendMessage(chatId: string, message: ChatMessage): Promise<Chat> {
    const chat = await this.get(chatId);
    chat.messages.push(message);
    if (message.role === "user" && chat.title === "New chat") {
      chat.title = titleFromMessage(message.content);
    }
    chat.updatedAt = new Date().toISOString();
    await this.save(chat);
    return chat;
  }

  async updateMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>): Promise<Chat> {
    const chat = await this.get(chatId);
    const index = chat.messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Error(`Message ${messageId} was not found`);
    chat.messages[index] = { ...chat.messages[index]!, ...patch };
    chat.updatedAt = new Date().toISOString();
    await this.save(chat);
    return chat;
  }

  async setSessionFile(chatId: string, sessionFile: string): Promise<void> {
    const chat = await this.get(chatId);
    chat.sessionFile = sessionFile;
    await this.save(chat);
  }

  private async save(chat: Chat): Promise<void> {
    await this.atomicWrite(this.chatPath(chat.id), chat);
    const index = await this.readIndex();
    const summary = this.toSummary(chat);
    const existing = index.chats.findIndex((candidate) => candidate.id === chat.id);
    if (existing >= 0) index.chats[existing] = summary;
    else index.chats.push(summary);
    await this.writeIndex(index);
  }

  private async readIndex(): Promise<ChatIndex> {
    return JSON.parse(await readFile(this.indexPath, "utf8")) as ChatIndex;
  }

  private writeIndex(index: ChatIndex): Promise<void> {
    return this.atomicWrite(this.indexPath, index);
  }

  private chatPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid chat ID");
    return join(this.chatsDir, `${id}.json`);
  }

  private toSummary(chat: Chat): ChatSummary {
    return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
}

function titleFromMessage(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 42 ? `${compact.slice(0, 41).trimEnd()}…` : compact;
}
