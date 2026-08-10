import { describe, expect, it } from "vitest";
import { authenticate } from "./auth";

describe("Eva cloud authentication", () => {
  const env = { EVA_API_TOKEN: "a-long-random-test-token" } as Env;

  it("accepts the owner bearer token without exposing it in identity", async () => {
    const user = await authenticate(new Request("https://eva.example/api/me", {
      headers: { authorization: "Bearer a-long-random-test-token" },
    }), env);

    expect(user).toMatchObject({ identity: "owner", method: "token" });
    expect(user?.id).toHaveLength(64);
  });

  it("rejects missing and incorrect tokens", async () => {
    await expect(authenticate(new Request("https://eva.example/api/me"), env)).resolves.toBeNull();
    await expect(authenticate(new Request("https://eva.example/api/me?token=incorrect"), env)).resolves.toBeNull();
  });

  it("accepts a WebSocket subprotocol token so credentials stay out of URLs", async () => {
    const user = await authenticate(new Request("https://eva.example/api/ws", {
      headers: { "sec-websocket-protocol": "eva-v1, eva-token.a-long-random-test-token" },
    }), env);

    expect(user?.method).toBe("token");
  });
});
