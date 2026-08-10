import type { Chat } from "../../../../../packages/protocol/src/index";

export type OutboxTurn = {
  chatId: string;
  title: string;
  createdAt: string;
  userMessage: Chat["messages"][number];
  assistantMessage: Chat["messages"][number];
  toolCalls: Chat["toolCalls"];
};

export function offlineTurnFromChat(chat: Chat, syncToolOutput: boolean): OutboxTurn | undefined {
  let assistantIndex = -1;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    if (chat.messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 1) return undefined;
  const assistantMessage = chat.messages[assistantIndex]!;
  const userMessage = [...chat.messages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user");
  if (!userMessage) return undefined;
  return {
    chatId: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    userMessage: { ...userMessage, executionHost: "device" },
    assistantMessage: { ...assistantMessage, executionHost: "device" },
    toolCalls: chat.toolCalls
      .filter((toolCall) => toolCall.assistantMessageId === assistantMessage.id)
      .map((toolCall) => ({ ...toolCall, output: syncToolOutput ? toolCall.output : "[Output kept on device]" })),
  };
}

export function addTurnIdempotently(turns: OutboxTurn[], turn: OutboxTurn): OutboxTurn[] {
  return turns.some((candidate) => candidate.assistantMessage.id === turn.assistantMessage.id) ? turns : [...turns, turn];
}

export function acknowledgeTurn(turns: OutboxTurn[], assistantMessageId: string): OutboxTurn[] {
  return turns.filter((turn) => turn.assistantMessage.id !== assistantMessageId);
}
