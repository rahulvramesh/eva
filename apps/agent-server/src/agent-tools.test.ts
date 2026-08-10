import { describe, expect, it } from "vitest";
import { htmlToText, isPublicIpAddress, resolveWindowsShell } from "./agent-tools";

describe("Eva agent tools", () => {
  it("prefers Git Bash on Windows and falls back to PowerShell", () => {
    const environment = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };
    expect(resolveWindowsShell(environment, (path) => path.endsWith("Git\\bin\\bash.exe"))).toEqual({
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
      kind: "bash",
    });
    expect(resolveWindowsShell(environment, (path) => path.endsWith("powershell.exe"))).toEqual({
      path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      kind: "powershell",
    });
  });

  it("blocks local network addresses and accepts public addresses", () => {
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("192.168.1.20")).toBe(false);
    expect(isPublicIpAddress("198.51.100.10")).toBe(false);
    expect(isPublicIpAddress("203.0.113.10")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicIpAddress("2001:db8::1")).toBe(false);
    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("turns HTML into compact readable text", () => {
    expect(htmlToText("<h1>Eva &amp; Pi</h1><script>ignore()</script><p>Hello<br>world</p>"))
      .toBe("Eva & Pi\nHello\nworld");
  });
});
