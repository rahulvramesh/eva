import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactToolInput } from "./tool-security";

describe("tool credential redaction", () => {
  it("removes bearer credentials from command previews and output", () => {
    const secret = "example-sensitive-token";
    const command = `curl -H "Authorization: Bearer ${secret}" https://example.com`;
    const redacted = redactSensitiveText(command);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
  });

  it("removes credentials assigned to shell variables", () => {
    const command = 'TOKEN="example-sensitive-token" curl -H "Authorization: Bearer $TOKEN" https://example.com';
    const redacted = redactSensitiveText(command);
    expect(redacted).not.toContain("example-sensitive-token");
    expect(redacted).toContain('TOKEN="[REDACTED]');
  });

  it("redacts nested tool input without mutating the executable input", () => {
    const input = { command: "API_KEY=example-key run", nested: { password: "password=example-password" } };
    const redacted = redactToolInput(input);
    expect(JSON.stringify(redacted)).not.toContain("example-key");
    expect(JSON.stringify(redacted)).not.toContain("example-password");
    expect(input.command).toContain("example-key");
  });
});
