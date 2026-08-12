import type { ModelMessage } from "./db";

export type ModelToolRequest = { id: string; name: string; input: Record<string, unknown> };

export function appendAssistantToolRequest(
  messages: ModelMessage[],
  content: string,
  toolCalls: ModelToolRequest[],
): void {
  messages.push({
    role: "assistant",
    content: content || null,
    tool_calls: toolCalls.map((request) => ({
      id: request.id,
      type: "function",
      function: { name: request.name, arguments: JSON.stringify(request.input) },
    })),
  });
}

export function toChatCompletionMessages(messages: ModelMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "system") return { role: "system", content: message.content ?? "" };
    if (message.role === "assistant") return {
      role: "assistant",
      content: message.content ?? "",
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    };
    if (message.role === "tool") return { role: "tool", content: message.content ?? "", tool_call_id: message.tool_call_id ?? "tool" };
    return { role: "user", content: message.content ?? "" };
  });
}

export function pendingApprovedTool(messages: ModelMessage[], toolCallId: string): { name: "bash" | "python_session"; input: Record<string, unknown> } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const request = messages[index]?.tool_calls?.find((candidate) => candidate.id === toolCallId);
    if (!request || (request.function.name !== "bash" && request.function.name !== "python_session")) continue;
    const input = parseObject(request.function.arguments);
    if (request.function.name === "bash" && typeof input.command === "string" && input.command.trim()) return { name: "bash", input };
    if (request.function.name === "python_session" && typeof input.code === "string" && input.code.trim()) return { name: "python_session", input };
    break;
  }
  throw new Error("The approved tool request could not be restored safely.");
}

export function pendingBashCommand(messages: ModelMessage[], toolCallId: string): string {
  const request = pendingApprovedTool(messages, toolCallId);
  if (request.name !== "bash") throw new Error("The approved Bash request could not be restored safely.");
  return String(request.input.command);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
