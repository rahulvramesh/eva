import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { command, type Chat, type ServerEvent } from "../../../packages/protocol/src/index";
import { FakeAgentBackend } from "./agent-backend";
import { ChatRepository } from "./chat-repository";
import { AgentServer } from "./server";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe("AgentServer", () => {
  it("creates a chat, streams a response, and persists the transcript", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const repository = new ChatRepository(directory);
    const server = new AgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      repository,
      backend: new FakeAgentBackend(),
    });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    cleanup.push(async () => socket.close());
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await waitFor(() => events.some((event) => event.type === "server.hello"));

    socket.send(JSON.stringify(command("chat.create", {})));
    const created = await findEvent(events, "chat.created");
    const chat = created.payload.chat;
    socket.send(JSON.stringify(command("message.send", { chatId: chat.id, content: "Hello there" })));
    await waitFor(() => events.some((event) => event.type === "run.status" && event.payload.status === "idle"));

    const restored = await repository.get(chat.id);
    expect(restored.title).toBe("Hello there");
    expect(restored.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(restored.messages[1]?.content).toBe("I’m Eva. You said: “Hello there”");
    expect(events.filter((event) => event.type === "assistant.delta").length).toBeGreaterThan(2);
  });

  it("streams and persists tool-call activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const repository = new ChatRepository(directory);
    const server = new AgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      repository,
      backend: new FakeAgentBackend(),
    });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    cleanup.push(async () => socket.close());
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await waitFor(() => events.some((event) => event.type === "server.hello"));
    socket.send(JSON.stringify(command("chat.create", {})));
    const chat = (await findEvent(events, "chat.created")).payload.chat;
    socket.send(JSON.stringify(command("message.send", { chatId: chat.id, content: "Check the Claude command" })));
    await waitFor(() => events.some((event) => event.type === "run.status" && event.payload.status === "idle"));
    const restored = await repository.get(chat.id);
    expect(restored.toolCalls).toEqual([expect.objectContaining({
      name: "bash",
      input: { command: "command -v claude && claude --version" },
      output: expect.stringContaining("2.1.222"),
      status: "complete",
    })]);
    expect(events.some((event) => event.type === "tool.call")).toBe(true);
    expect(events.some((event) => event.type === "tool.update" && event.payload.toolCall.status === "complete")).toBe(true);
  });

  it("persists and broadcasts model-selected generative UI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const repository = new ChatRepository(directory);
    const server = new AgentServer({ host: "127.0.0.1", port: 0, token: "test-token", repository, backend: new FakeAgentBackend() });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    cleanup.push(async () => socket.close());
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await waitFor(() => events.some((event) => event.type === "server.hello"));
    socket.send(JSON.stringify(command("chat.create", {})));
    const chat = (await findEvent(events, "chat.created")).payload.chat;
    socket.send(JSON.stringify(command("message.send", { chatId: chat.id, content: "Make a plan for this" })));
    await waitFor(() => events.some((event) => event.type === "run.status" && event.payload.status === "idle"));
    const restored = await repository.get(chat.id);
    expect(restored.messages.at(-1)?.uiBlocks[0]).toMatchObject({ kind: "plan", title: "Eva plan" });
    expect(events.some((event) => event.type === "message.updated" && event.payload.message.uiBlocks.some((block) => block.kind === "plan"))).toBe(true);
    expect(restored.toolCalls.some((tool) => tool.name === "present_plan")).toBe(false);
  });

  it("runs separate chats concurrently and aborts only the selected chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const repository = new ChatRepository(directory);
    const server = new AgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      repository,
      backend: new FakeAgentBackend(),
    });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    cleanup.push(async () => socket.close());
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await waitFor(() => events.some((event) => event.type === "server.hello"));

    socket.send(JSON.stringify(command("chat.create", {})));
    await waitFor(() => events.filter((event) => event.type === "chat.created").length === 1);
    socket.send(JSON.stringify(command("chat.create", {})));
    await waitFor(() => events.filter((event) => event.type === "chat.created").length === 2);
    const created = events.filter((event): event is Extract<ServerEvent, { type: "chat.created" }> => event.type === "chat.created");
    const [first, second] = created.map((event) => event.payload.chat);
    if (!first || !second) throw new Error("Chats were not created");

    const longPrompt = "Keep streaming this deliberately long response so both chats overlap ".repeat(4);
    socket.send(JSON.stringify(command("message.send", { chatId: first.id, content: `${longPrompt}first` })));
    socket.send(JSON.stringify(command("message.send", { chatId: second.id, content: `${longPrompt}second` })));
    await waitFor(() => new Set(events
      .filter((event): event is Extract<ServerEvent, { type: "run.status" }> => event.type === "run.status" && event.payload.status === "running")
      .map((event) => event.payload.chatId)).size === 2).catch(() => {
        throw new Error(`Concurrent starts were not observed: ${JSON.stringify(events.filter((event) => event.type === "run.status" || event.type === "server.error"))}`);
      });
    socket.send(JSON.stringify(command("run.abort", { chatId: first.id })));
    await waitFor(() => events.some((event) => event.type === "run.status" && event.payload.chatId === first.id && event.payload.status === "aborted"));
    await waitFor(() => events.some((event) => event.type === "run.status" && event.payload.chatId === second.id && event.payload.status === "idle"));

    expect((await repository.get(first.id)).messages.at(-1)?.status).toBe("aborted");
    expect((await repository.get(second.id)).messages.at(-1)?.status).toBe("complete");
    expect(events.some((event) => event.type === "server.error" && event.payload.message.includes("current response"))).toBe(false);
  });

  it("rejects an incorrect token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const server = new AgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "right-token",
      repository: new ChatRepository(directory),
      backend: new FakeAgentBackend(),
    });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.ok).toBe(true);
    await expect(new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong-token`);
      socket.once("open", () => resolve());
      socket.once("error", reject);
    })).rejects.toThrow();
  });

  it("returns and updates capability-aware model settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const server = new AgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      repository: new ChatRepository(directory),
      backend: new FakeAgentBackend(),
    });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    cleanup.push(async () => socket.close());
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await waitFor(() => events.some((event) => event.type === "server.hello"));

    socket.send(JSON.stringify(command("settings.get", {})));
    const snapshot = await findEvent(events, "settings.snapshot");
    expect(snapshot.payload.settings.models).toHaveLength(3);

    socket.send(JSON.stringify(command("settings.update", {
      provider: "demo",
      modelId: "eva-fast",
      thinkingLevel: "high",
      systemInstructions: "  Be concise.  ",
    })));
    const updated = await findEvent(events, "settings.updated");
    expect(updated.payload.settings.selectedModel.id).toBe("eva-fast");
    expect(updated.payload.settings.thinkingLevel).toBe("off");
    expect(updated.payload.settings.systemInstructions).toBe("Be concise.");
  });

  it("executes a cloud-coordinated turn on the device and streams tool provenance back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eva-server-"));
    const repository = new ChatRepository(directory);
    const server = new AgentServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      repository,
      backend: new FakeAgentBackend(),
    });
    const port = await server.listen();
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    cleanup.push(async () => socket.close());
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await waitFor(() => events.some((event) => event.type === "server.hello"));

    const timestamp = "2026-08-10T00:00:00.000Z";
    const chat: Chat = {
      id: crypto.randomUUID(),
      title: "Device check",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { id: "user-1", role: "user", content: "Check the command", status: "complete", createdAt: timestamp, uiBlocks: [] },
        { id: "assistant-1", role: "assistant", content: "", status: "streaming", createdAt: timestamp, uiBlocks: [] },
      ],
      toolCalls: [],
    };
    socket.send(JSON.stringify(command("device.turn.execute", {
      turnId: "turn-1",
      chat,
      content: "Check the command",
      routing: "device",
    })));
    const completed = await findEvent(events, "device.turn.complete");
    expect(completed.payload).toMatchObject({ turnId: "turn-1", chatId: chat.id, status: "complete" });
    expect(completed.payload.content).toContain("local installation details");
    expect(events.some((event) => event.type === "device.turn.delta")).toBe(true);
    expect(events.some((event) => event.type === "device.turn.tool" && event.payload.toolCall.status === "complete")).toBe(true);
    await expect(repository.get(chat.id)).rejects.toThrow();
  });
});

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for server event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function findEvent<T extends ServerEvent["type"]>(events: ServerEvent[], type: T): Promise<Extract<ServerEvent, { type: T }>> {
  await waitFor(() => events.some((event) => event.type === type));
  return events.find((event) => event.type === type) as Extract<ServerEvent, { type: T }>;
}
