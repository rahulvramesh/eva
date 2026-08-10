import { getSandbox } from "@cloudflare/sandbox";
import { parsePublicUrl } from "./web-security";

const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_FETCH_BYTES = 512 * 1024;

export async function runBash(env: Env, userId: string, command: string): Promise<string> {
  if (!command.trim()) throw new Error("The Bash command was empty.");
  if (command.length > 20_000) throw new Error("The Bash command is too long.");
  const sandbox = getSandbox(env.Sandbox, `eva-tools-v3-${userId.slice(0, 32)}`, {
    sleepAfter: "10m",
    labels: { application: "eva", workload: "bash", user: userId.slice(0, 12) },
  });
  await ensurePersistentWorkspace(sandbox, env, userId);
  const result = await sandbox.exec(command, { cwd: "/workspace/data", timeout: 120_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, MAX_TOOL_OUTPUT);
  if (!result.success) throw new Error(output || `Command exited with code ${result.exitCode}.`);
  return output || `Command completed with exit code ${result.exitCode}.`;
}

async function ensurePersistentWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  userId: string,
): Promise<void> {
  try {
    const localDev = (env as Env & { EVA_LOCAL_DEV?: string }).EVA_LOCAL_DEV === "true";
    await sandbox.mountBucket("WORKSPACES", "/workspace/data", {
      prefix: `/users/${userId}/workspace/`,
      ...(localDev ? { localBucket: true as const } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!message.includes("already") && !message.includes("mounted")) throw error;
  }
}

export async function runWebFetch(rawUrl: string): Promise<string> {
  let url = parsePublicUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Web fetch timed out"), 15_000);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "Eva/0.1 (+https://github.com/rahulvramesh/eva)", accept: "text/*,application/json,application/xml" },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The redirect did not include a destination.");
      url = parsePublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Web fetch failed with HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
      throw new Error(`Web fetch does not accept content type ${contentType || "unknown"}.`);
    }
    const body = await readBoundedBody(response, MAX_FETCH_BYTES);
    return `Source: ${url.toString()}\nContent-Type: ${contentType || "unknown"}\n\n${body}`;
  }
  throw new Error("Web fetch exceeded the redirect limit.");
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`Web fetch response exceeded ${limit} bytes.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
