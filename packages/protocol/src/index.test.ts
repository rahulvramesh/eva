import { describe, expect, it } from "vitest";
import { clientCommandSchema, command, PROTOCOL_VERSION } from "./index";

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
});
