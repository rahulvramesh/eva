import { describe, expect, it } from "vitest";
import type { Memory } from "../../../packages/protocol/src/index";
import { mergeRetrievedMemories } from "./memory";

function memory(id: string, kind: Memory["kind"], importance = 5): Memory {
  return {
    id,
    kind,
    importance,
    content: id,
    status: "active",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("memory retrieval merge", () => {
  it("returns authoritative profile memory even without a vector match", () => {
    expect(mergeRetrievedMemories([memory("github", "profile", 7)], [])).toEqual([
      expect.objectContaining({ id: "github" }),
    ]);
  });

  it("deduplicates D1 and vector results", () => {
    const github = memory("github", "profile", 7);
    expect(mergeRetrievedMemories([github], [{ memory: github, score: 0.9 }])).toHaveLength(1);
  });
});
