import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRepository } from "./chat-repository";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ChatRepository", () => {
  it("creates, titles, persists, and lists chats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-repository-"));
    cleanup.push(directory);
    const repository = new ChatRepository(directory);
    await repository.initialize();
    const chat = await repository.create();
    await repository.appendMessage(chat.id, {
      id: randomUUID(),
      role: "user",
      content: "Help me make a lightweight personal assistant with a very long title",
      createdAt: new Date().toISOString(),
      status: "complete",
    });

    const restored = await repository.get(chat.id);
    const list = await repository.list();
    expect(restored.title).toBe("Help me make a lightweight personal assis…");
    expect(restored.messages).toHaveLength(1);
    expect(list).toEqual([expect.objectContaining({ id: chat.id, title: restored.title })]);
    expect(await readFile(join(directory, "chats", `${chat.id}.json`), "utf8")).toContain(restored.title);
  });

  it("rejects unsafe chat paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-repository-"));
    cleanup.push(directory);
    const repository = new ChatRepository(directory);
    await repository.initialize();
    await expect(repository.get("../../secret")).rejects.toThrow("Invalid chat ID");
  });
});
