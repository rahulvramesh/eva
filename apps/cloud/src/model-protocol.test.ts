import { describe, expect, it } from "vitest";
import type { ModelMessage } from "./db";
import { appendAssistantToolRequest, pendingBashCommand, toChatCompletionMessages } from "./model-protocol";

describe("model tool-call protocol", () => {
  it("preserves the provider tool-call ID through an approval continuation", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Run it" }];
    appendAssistantToolRequest(messages, "", [{ id: "call_bash_1", name: "bash", input: { command: "printf done" } }]);
    messages.push({ role: "tool", content: "done", tool_call_id: "call_bash_1" });

    const wire = toChatCompletionMessages(messages);
    expect(wire[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_bash_1", function: { name: "bash" } }],
    });
    expect(wire[2]).toMatchObject({ role: "tool", tool_call_id: "call_bash_1", content: "done" });
    expect(pendingBashCommand(messages, "call_bash_1")).toBe("printf done");
  });

  it("refuses to restore a command for a mismatched tool-call ID", () => {
    const messages: ModelMessage[] = [];
    appendAssistantToolRequest(messages, "", [{ id: "call_bash_1", name: "bash", input: { command: "printf done" } }]);
    expect(() => pendingBashCommand(messages, "different-id")).toThrow("could not be restored safely");
  });
});
