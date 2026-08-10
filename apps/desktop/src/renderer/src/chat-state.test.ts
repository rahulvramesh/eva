import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "../../../../../packages/protocol/src/index";
import { appendAssistantDelta, appendMessage, mergeChatSnapshot } from "./chat-state";

const now = "2026-08-10T00:00:00.000Z";
const emptyChat = (id: string): Chat => ({ id, title: id, createdAt: now, updatedAt: now, messages: [], toolCalls: [] });
const message = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({ id, role, content, status: "streaming", createdAt: now, uiBlocks: [] });

describe("concurrent renderer chat state", () => {
  it("keeps deltas isolated by chat", () => {
    const first = appendAssistantDelta(appendMessage(emptyChat("a"), message("ma", "assistant", "")), "ma", "A");
    const second = appendAssistantDelta(appendMessage(emptyChat("b"), message("mb", "assistant", "")), "mb", "B");
    expect(first.messages[0]?.content).toBe("A");
    expect(second.messages[0]?.content).toBe("B");
  });

  it("does not let a stale snapshot erase streamed content", () => {
    const cached = appendAssistantDelta(appendMessage(emptyChat("a"), message("ma", "assistant", "")), "ma", "partial");
    const snapshot = { ...emptyChat("a"), messages: [message("ma", "assistant", "")] };
    expect(mergeChatSnapshot(cached, snapshot).messages[0]?.content).toBe("partial");
  });
});
