import { describe, expect, it } from "vitest";
import { claimsUnverifiedMemorySave, explicitlyRequestsMemory, isVerifiedMemoryReceipt } from "./memory-policy";

describe("memory policy", () => {
  it.each([
    "remember https://github.com/rahulvramesh/ this is my personal github",
    "Please save that my preferred editor is Zed.",
    "Could you store this as a profile fact?",
  ])("detects an explicit write request: %s", (content) => {
    expect(explicitlyRequestsMemory([{ role: "user", content }])).toBe(true);
  });

  it("does not mistake a recall question for a write request", () => {
    expect(explicitlyRequestsMemory([{ role: "user", content: "Do you remember my GitHub profile?" }])).toBe(false);
  });

  it("detects unsupported save claims", () => {
    expect(claimsUnverifiedMemorySave("I've saved that to memory for next time.")).toBe(true);
  });

  it("only accepts deterministic tool receipts", () => {
    expect(isVerifiedMemoryReceipt("Memory saved \u2713 [7290f395]: Rahul's GitHub profile")).toBe(true);
    expect(isVerifiedMemoryReceipt("Sure, I saved it.")).toBe(false);
  });
});
