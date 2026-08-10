import { z } from "zod";
import type { Memory } from "../../../packages/protocol/src/index";
import { getAuthoritativeMemories, getMemoriesByIds, touchMemories } from "./db";

const queueMessageSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("upsert"), userId: z.string(), memoryId: z.string(), content: z.string() }),
  z.object({ operation: z.literal("delete"), userId: z.string(), memoryId: z.string() }),
]);

export type MemoryQueueMessage = z.infer<typeof queueMessageSchema>;

export async function enqueueMemory(env: Env, userId: string, memory: Memory): Promise<void> {
  await env.MEMORY_QUEUE.send({ operation: "upsert", userId, memoryId: memory.id, content: memory.content } satisfies MemoryQueueMessage);
}

export async function enqueueMemoryDelete(env: Env, userId: string, memoryId: string): Promise<void> {
  await env.MEMORY_QUEUE.send({ operation: "delete", userId, memoryId } satisfies MemoryQueueMessage);
}

export async function retrieveMemories(env: Env, userId: string, query: string): Promise<Memory[]> {
  if (!query.trim()) return [];
  const recentSince = new Date(Date.now() - 5 * 60_000).toISOString();
  let authoritative: Memory[] = [];
  let semantic: Array<{ memory: Memory; score: number }> = [];

  try {
    authoritative = await getAuthoritativeMemories(env.DB, userId, recentSince);
  } catch (error) {
    console.warn(JSON.stringify({ event: "memory.authoritative.failed", userId: shortId(userId), error: errorMessage(error) }));
  }

  try {
    const embedding = await embed(env, query);
    const result = await env.MEMORY_INDEX.query(embedding, {
      namespace: userId,
      topK: 8,
      returnMetadata: "none",
      returnValues: false,
    });
    const memories = await getMemoriesByIds(env.DB, userId, result.matches.map((match) => match.id));
    const score = new Map(result.matches.map((match) => [match.id, match.score]));
    semantic = memories.map((memory) => ({ memory, score: score.get(memory.id) ?? 0 }));
  } catch (error) {
    console.warn(JSON.stringify({ event: "memory.retrieve.failed", userId: shortId(userId), error: errorMessage(error) }));
  }

  const selected = mergeRetrievedMemories(authoritative, semantic);
  if (selected.length) {
    try {
      await touchMemories(env.DB, userId, selected.map((memory) => memory.id));
    } catch (error) {
      console.warn(JSON.stringify({ event: "memory.touch.failed", userId: shortId(userId), error: errorMessage(error) }));
    }
  }
  return selected;
}

export function mergeRetrievedMemories(
  authoritative: Memory[],
  semantic: Array<{ memory: Memory; score: number }>,
  limit = 16,
): Memory[] {
  const entries = new Map<string, { memory: Memory; authoritative: boolean; semanticScore: number }>();
  for (const memory of authoritative) entries.set(memory.id, { memory, authoritative: true, semanticScore: 0 });
  for (const match of semantic) {
    const existing = entries.get(match.memory.id);
    entries.set(match.memory.id, {
      memory: match.memory,
      authoritative: existing?.authoritative ?? false,
      semanticScore: Math.max(existing?.semanticScore ?? 0, match.score),
    });
  }
  return [...entries.values()]
    .sort((left, right) => memoryRank(right) - memoryRank(left))
    .slice(0, limit)
    .map((entry) => entry.memory);
}

function memoryRank(entry: { memory: Memory; authoritative: boolean; semanticScore: number }): number {
  const durableKind = ["profile", "preference", "instruction"].includes(entry.memory.kind);
  return (entry.authoritative ? 1.25 : 0) + (durableKind ? 0.5 : 0) + entry.semanticScore + entry.memory.importance / 20;
}

export async function consumeMemoryQueue(batch: MessageBatch<MemoryQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = queueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    try {
      if (parsed.data.operation === "delete") {
        await env.MEMORY_INDEX.deleteByIds([parsed.data.memoryId]);
      } else {
        const values = await embed(env, parsed.data.content);
        await env.MEMORY_INDEX.upsert([{
          id: parsed.data.memoryId,
          namespace: parsed.data.userId,
          values,
          metadata: { kind: "memory" },
        }]);
      }
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({ event: "memory.index.failed", memoryId: parsed.data.memoryId, error: errorMessage(error) }));
      message.retry({ delaySeconds: 30 });
    }
  }
}

async function embed(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run(env.EVA_EMBEDDING_MODEL, { text: [text.slice(0, 8_000)] });
  const values = "data" in result ? result.data?.[0] : undefined;
  if (!values?.length) throw new Error("Embedding model returned no vector.");
  return values;
}

function shortId(value: string): string {
  return value.slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
