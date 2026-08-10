import { describe, expect, it } from "vitest";
import { chatSchema, clientCommandSchema, command, PROTOCOL_VERSION } from "./index";

describe("protocol", () => {
  it("creates schema-valid commands", () => {
    const value = command("message.send", { chatId: "chat-1", content: "hello" });
    expect(clientCommandSchema.parse(value)).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "message.send",
      chatId: "chat-1",
      content: "hello",
    });
  });

  it("rejects empty and oversized commands", () => {
    expect(clientCommandSchema.safeParse({
      version: PROTOCOL_VERSION,
      requestId: "request-1",
      type: "message.send",
      chatId: "chat-1",
      content: "   ",
    }).success).toBe(false);
  });

  it("validates model-setting updates", () => {
    expect(clientCommandSchema.safeParse(command("settings.update", {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      thinkingLevel: "high",
      systemInstructions: "Be concise.",
    })).success).toBe(true);
  });

  it("migrates snapshots without tool calls to an empty tool timeline", () => {
    const chat = chatSchema.parse({
      id: "chat-1",
      title: "Legacy chat",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      messages: [],
    });
    expect(chat.toolCalls).toEqual([]);
  });

  it("validates hybrid device registration and execution commands", () => {
    const device = {
      id: "device-1",
      name: "Rahul's Mac",
      platform: "darwin",
      workspace: "/Users/rahul/workspace",
      models: [{
        provider: "ollama",
        id: "qwen3",
        name: "Qwen 3",
        thinkingLevels: ["off" as const],
        executionHost: "device" as const,
        deviceId: "device-1",
        localInference: true,
      }],
      tools: ["bash", "web_fetch"],
    };
    expect(clientCommandSchema.safeParse(command("device.register", { device })).success).toBe(true);
    expect(clientCommandSchema.safeParse(command("device.turn.execute", {
      turnId: "turn-1",
      content: "Inspect the repository",
      routing: "device",
      chat: {
        id: "chat-1",
        title: "Repository",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: "2026-08-10T00:00:00.000Z",
        }],
        toolCalls: [],
      },
    })).success).toBe(true);
  });
});
