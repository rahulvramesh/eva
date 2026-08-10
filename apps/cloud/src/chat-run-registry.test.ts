import { describe, expect, it } from "vitest";
import { ChatRunRegistry } from "./chat-run-registry";

describe("ChatRunRegistry", () => {
  it("allows separate chats and rejects a second turn in the same chat", () => {
    const runs = new ChatRunRegistry(3);
    runs.start("a");
    runs.start("b");
    expect(() => runs.start("a")).toThrow("this chat's current response");
    expect(runs.activeChatIds()).toEqual(["a", "b"]);
  });

  it("enforces the total cap including persisted device turns", () => {
    const runs = new ChatRunRegistry(3);
    runs.start("cloud");
    expect(() => runs.start("new", ["device-a", "device-b"])).toThrow("up to 3 chats");
  });

  it("scopes abort state to one chat", () => {
    const runs = new ChatRunRegistry();
    runs.start("a");
    runs.start("b");
    const signal = runs.signal("a");
    runs.requestAbort("a");
    expect(runs.isAborted("a")).toBe(true);
    expect(runs.isAborted("b")).toBe(false);
    expect(signal?.aborted).toBe(true);
    runs.finish("a");
    expect(runs.isAborted("a")).toBe(false);
  });
});
