import type { Chat, ChatMessage, ToolCall } from "../../../../../packages/protocol/src/index";

export function mergeChatSnapshot(current: Chat | undefined, snapshot: Chat): Chat {
  if (!current) return snapshot;
  const currentMessages = new Map(current.messages.map((message) => [message.id, message]));
  const messages = snapshot.messages.map((message) => {
    const cached = currentMessages.get(message.id);
    return cached && cached.content.length > message.content.length ? cached : message;
  });
  for (const message of current.messages) {
    if (!messages.some((candidate) => candidate.id === message.id)) messages.push(message);
  }
  const tools = new Map(snapshot.toolCalls.map((tool) => [tool.id, tool]));
  for (const tool of current.toolCalls) {
    const fromSnapshot = tools.get(tool.id);
    if (!fromSnapshot || toolStatusRank(tool.status) >= toolStatusRank(fromSnapshot.status)) tools.set(tool.id, tool);
  }
  return { ...snapshot, messages, toolCalls: [...tools.values()] };
}

function toolStatusRank(status: ToolCall["status"]): number {
  return status === "pending" ? 0 : status === "running" ? 1 : 2;
}

export function appendMessage(chat: Chat, message: ChatMessage): Chat {
  if (chat.messages.some((candidate) => candidate.id === message.id)) return chat;
  return { ...chat, messages: [...chat.messages, message] };
}

export function upsertMessage(chat: Chat, message: ChatMessage): Chat {
  return chat.messages.some((candidate) => candidate.id === message.id)
    ? { ...chat, messages: chat.messages.map((candidate) => candidate.id === message.id ? message : candidate) }
    : { ...chat, messages: [...chat.messages, message] };
}

export function appendAssistantDelta(chat: Chat, messageId: string, delta: string): Chat {
  return {
    ...chat,
    messages: chat.messages.map((message) => message.id === messageId
      ? { ...message, content: message.content + delta }
      : message),
  };
}

export function upsertToolCall(chat: Chat, toolCall: ToolCall): Chat {
  return {
    ...chat,
    toolCalls: chat.toolCalls.some((candidate) => candidate.id === toolCall.id)
      ? chat.toolCalls.map((candidate) => candidate.id === toolCall.id ? toolCall : candidate)
      : [...chat.toolCalls, toolCall],
  };
}

export function completeAssistantMessage(chat: Chat, messageId: string, content: string, status: ChatMessage["status"], uiBlocks?: ChatMessage["uiBlocks"]): Chat {
  return {
    ...chat,
    messages: chat.messages.map((message) => message.id === messageId ? { ...message, content, status, uiBlocks: uiBlocks ?? message.uiBlocks } : message),
  };
}
