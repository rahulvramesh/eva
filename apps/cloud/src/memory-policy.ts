import type { ModelMessage } from "./db";

export const MEMORY_SAFETY_INSTRUCTION = [
  "Memory safety rules:",
  "- Never claim that information was saved, stored, or remembered unless the remember tool succeeded in this turn.",
  "- When the user explicitly asks to remember, save, store, or memorize durable information, call the remember tool before replying.",
  "- Treat the tool's verified receipt as the only proof that a memory write succeeded.",
].join("\n");

export function explicitlyRequestsMemory(messages: ModelMessage[]): boolean {
  const content = [...messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  if (!content || /\bdo you remember\b/i.test(content)) return false;
  return /(?:^|[.!?]\s*)(?:please\s+)?(?:remember|save|store|memorize)\b/i.test(content)
    || /\b(?:can|could|would|will) you (?:please )?(?:remember|save|store|memorize)\b/i.test(content);
}

export function claimsUnverifiedMemorySave(content: string): boolean {
  return /\b(?:saved|stored|memorized)\b[^.!?\n]{0,100}\b(?:memory|next time)\b/i.test(content)
    || /\bremember(?:ed)? (?:it|that|this) for (?:the )?next time\b/i.test(content);
}

export function isVerifiedMemoryReceipt(output: string): boolean {
  return output.startsWith("Memory saved \u2713 [");
}
