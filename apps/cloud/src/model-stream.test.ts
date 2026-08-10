import { describe, expect, it, vi } from "vitest";
import { consumeChatCompletionStream } from "./model-stream";

function sseStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("Workers AI stream consumption", () => {
  it("forwards text deltas as they arrive", async () => {
    const onText = vi.fn();
    const result = await consumeChatCompletionStream(sseStream([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Rahul"}}]}\n\ndata: [DONE]\n\n',
    ]), onText);
    expect(onText.mock.calls.map(([delta]) => delta)).toEqual(["Hello ", "Rahul"]);
    expect(result.response).toBe("Hello Rahul");
  });

  it("assembles streamed tool-call arguments", async () => {
    const result = await consumeChatCompletionStream(sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"remember","arguments":"{\\"kind\\":\\"pro"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"file\\",\\"content\\":\\"GitHub\\",\\"importance\\":7}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => undefined);
    expect(result.tool_calls?.[0]).toEqual(expect.objectContaining({
      type: "function",
      function: {
        name: "remember",
        arguments: '{"kind":"profile","content":"GitHub","importance":7}',
      },
    }));
  });
});
