import { describe, expect, it } from "vitest";
import type { Chat } from "../../../../../packages/protocol/src/index";
import { acknowledgeTurn, addTurnIdempotently, offlineTurnFromChat } from "./offline-outbox";

const timestamp = "2026-08-10T00:00:00.000Z";
const chat: Chat = {
  id: "chat-1",
  title: "Offline work",
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: [
    { id: "user-1", role: "user", content: "Inspect a file", status: "complete", createdAt: timestamp },
    { id: "assistant-1", role: "assistant", content: "Done", status: "complete", createdAt: timestamp },
  ],
  toolCalls: [{
    id: "tool-1",
    assistantMessageId: "assistant-1",
    name: "bash",
    input: { command: "cat private.txt" },
    output: "private output",
    status: "complete",
    createdAt: timestamp,
    completedAt: timestamp,
  }],
};

describe("offline outbox", () => {
  it("syncs the completed response while redacting tool output by default", () => {
    const turn = offlineTurnFromChat(chat, false)!;
    expect(turn.assistantMessage).toMatchObject({ content: "Done", executionHost: "device" });
    expect(turn.toolCalls[0]?.output).toBe("[Output kept on device]");
  });

  it("can explicitly include tool output and remains idempotent through acknowledgement", () => {
    const turn = offlineTurnFromChat(chat, true)!;
    expect(turn.toolCalls[0]?.output).toBe("private output");
    const queued = addTurnIdempotently(addTurnIdempotently([], turn), turn);
    expect(queued).toHaveLength(1);
    expect(acknowledgeTurn(queued, "assistant-1")).toEqual([]);
  });
});
