import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { win32 } from "node:path";
import { createBashToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MAX_CHARACTERS = 24_000;
const MAX_CHARACTERS = 100_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_SECONDS = 20;

type WindowsShell = { path: string; kind: "bash" | "powershell" };

export function createEvaTools(cwd: string) {
  const windowsShell = process.platform === "win32" ? resolveWindowsShell(process.env) : undefined;
  const bash = createBashToolDefinition(cwd, windowsShell ? { shellPath: windowsShell.path } : undefined);
  const shellTool = windowsShell?.kind === "powershell"
    ? {
        ...bash,
        label: "PowerShell",
        description: "Execute a PowerShell command in Eva's workspace. Use PowerShell syntax because Eva is running on Windows.",
        promptSnippet: "Execute PowerShell commands in Eva's workspace",
        promptGuidelines: ["The shell tool uses PowerShell syntax on this Windows computer."],
      }
    : bash;

  return [defineTool(shellTool), createWebFetchTool()];
}

export function resolveWindowsShell(
  environment: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): WindowsShell | undefined {
  const explicit = environment.EVA_SHELL_PATH;
  if (explicit && fileExists(explicit)) {
    return { path: explicit, kind: /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(explicit) ? "powershell" : "bash" };
  }

  const programFiles = [environment.ProgramFiles, environment["ProgramFiles(x86)"]].filter((value): value is string => Boolean(value));
  const bashCandidates = programFiles.map((directory) => win32.join(directory, "Git", "bin", "bash.exe"));
  const powershellCandidates = [
    ...programFiles.map((directory) => win32.join(directory, "PowerShell", "7", "pwsh.exe")),
    environment.SystemRoot ? win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined,
  ].filter((value): value is string => Boolean(value));
  const pathCandidates = (environment.Path ?? environment.PATH ?? "")
    .split(";")
    .filter(Boolean)
    .flatMap((directory) => [
      { path: win32.join(directory, "bash.exe"), kind: "bash" as const },
      { path: win32.join(directory, "pwsh.exe"), kind: "powershell" as const },
      { path: win32.join(directory, "powershell.exe"), kind: "powershell" as const },
    ]);
  const candidates = [
    ...bashCandidates.map((path) => ({ path, kind: "bash" as const })),
    ...pathCandidates,
    ...powershellCandidates.map((path) => ({ path, kind: "powershell" as const })),
  ];
  return candidates.find((candidate) => fileExists(candidate.path));
}

function createWebFetchTool() {
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a public HTTP or HTTPS page and return readable text. Local, private, and link-local network addresses are blocked.",
    promptSnippet: "Fetch readable content from a public web URL",
    promptGuidelines: ["Use web_fetch when current information or the contents of a specific public URL are needed."],
    parameters: Type.Object({
      url: Type.String({ description: "Public HTTP or HTTPS URL to fetch" }),
      maxCharacters: Type.Optional(Type.Number({ minimum: 1_000, maximum: MAX_CHARACTERS, description: "Maximum text characters to return" })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 60, description: "Request timeout in seconds" })),
    }),
    execute: async (_toolCallId, parameters, signal) => {
      const maxCharacters = Math.floor(parameters.maxCharacters ?? DEFAULT_MAX_CHARACTERS);
      const timeoutSeconds = parameters.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const result = await fetchPublicUrl(parameters.url, maxCharacters, timeoutSeconds, signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          url: result.url,
          status: result.status,
          contentType: result.contentType,
          truncated: result.truncated,
        },
      };
    },
  });
}

async function fetchPublicUrl(
  input: string,
  maxCharacters: number,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<{ url: string; status: number; contentType: string; text: string; truncated: boolean }> {
  let url = parsePublicUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicHostname(url.hostname);
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1_000)])
      : AbortSignal.timeout(timeoutSeconds * 1_000);
    const response = await fetch(url, {
      redirect: "manual",
      signal: requestSignal,
      headers: {
        accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
        "user-agent": "Eva/0.1 (+https://github.com/rahulvramesh/eva)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Web fetch received redirect ${response.status} without a Location header.`);
      if (redirect === MAX_REDIRECTS) throw new Error(`Web fetch exceeded ${MAX_REDIRECTS} redirects.`);
      url = parsePublicUrl(new URL(location, url).toString());
      continue;
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream";
    if (!isTextContentType(contentType)) throw new Error(`Web fetch does not support content type ${contentType}.`);
    const body = await readBoundedText(response, MAX_RESPONSE_BYTES);
    const readable = contentType === "text/html" ? htmlToText(body.text) : body.text.trim();
    const truncated = body.truncated || readable.length > maxCharacters;
    const text = readable.slice(0, maxCharacters);
    const heading = `URL: ${url.toString()}\nStatus: ${response.status} ${response.statusText}\nContent-Type: ${contentType}`;
    return {
      url: url.toString(),
      status: response.status,
      contentType,
      truncated,
      text: `${heading}\n\n${text}${truncated ? "\n\n[Content truncated]" : ""}`,
    };
  }
  throw new Error("Web fetch failed.");
}

function parsePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Web fetch requires a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Web fetch only supports HTTP and HTTPS URLs.");
  if (url.username || url.password) throw new Error("Web fetch does not accept credentials embedded in URLs.");
  return url;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal")) {
    throw new Error("Web fetch cannot access local network hostnames.");
  }
  const addresses = isIP(normalized)
    ? [{ address: normalized }]
    : await lookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("Web fetch cannot access private, local, or reserved network addresses.");
  }
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mapped) return isPublicIpAddress(mapped);
    return !(normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:"));
  }
  return false;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, Math.max(remaining, 0)));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    if (total === maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")
    || contentType.includes("javascript") || contentType.includes("xhtml");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, value: string) => {
      const codePoint = Number(value);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
