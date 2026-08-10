export type StreamedModelResult = { response?: string; tool_calls?: ChatCompletionMessageToolCall[] };

type StreamingToolCall = { id: string; name: string; arguments: string };
type ChatCompletionStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

export async function consumeChatCompletionStream(
  stream: ReadableStream,
  onText: (delta: string) => void,
): Promise<StreamedModelResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, StreamingToolCall>();
  let buffer = "";
  let response = "";

  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as ChatCompletionStreamChunk;
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      response += delta.content;
      onText(delta.content);
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      current.id += call.id ?? "";
      current.name += call.function?.name ?? "";
      current.arguments += call.function?.arguments ?? "";
      toolCalls.set(index, current);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }

  return {
    response: response || undefined,
    tool_calls: [...toolCalls.values()].map((call) => ({
      id: call.id || crypto.randomUUID(),
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}
