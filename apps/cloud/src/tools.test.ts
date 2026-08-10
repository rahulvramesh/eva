import { describe, expect, it } from "vitest";
import { isPrivateHostname, parsePublicUrl } from "./web-security";

describe("Eva cloud web fetch guard", () => {
  it("accepts public HTTP and HTTPS URLs", () => {
    expect(parsePublicUrl("https://example.com/path").hostname).toBe("example.com");
    expect(parsePublicUrl("http://1.1.1.1/").hostname).toBe("1.1.1.1");
  });

  it.each([
    "localhost",
    "api.internal",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.31.1.2",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks private host %s", (hostname) => {
    expect(isPrivateHostname(hostname)).toBe(true);
  });

  it("blocks credentialed and non-HTTP URLs", () => {
    expect(() => parsePublicUrl("https://user:password@example.com/")).toThrow(/credentials/);
    expect(() => parsePublicUrl("file:///etc/passwd")).toThrow(/HTTP and HTTPS/);
  });
});
