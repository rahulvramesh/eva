import { z } from "zod";
import type { Memory } from "../../../packages/protocol/src/index";
import { getMemoriesByIds } from "./db";

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
    return memories.sort((left, right) => ((score.get(right.id) ?? 0) + right.importance / 20) - ((score.get(left.id) ?? 0) + left.importance / 20));
  } catch (error) {
    console.warn(JSON.stringify({ event: "memory.retrieve.failed", userId: shortId(userId), error: errorMessage(error) }));
    return [];
  }
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
