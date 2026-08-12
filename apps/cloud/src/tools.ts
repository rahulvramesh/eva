import { getSandbox, type CodeContext } from "@cloudflare/sandbox";
import { parsePublicUrl } from "./web-security";
import { formatPythonExecution } from "./python-output";

const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_FETCH_BYTES = 512 * 1024;
const PYTHON_CONTEXT_PREFIX = "python-context:";

export type PythonContextStore = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

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

export async function runPython(
  env: Env,
  contextStore: PythonContextStore,
  userId: string,
  chatId: string,
  code: string,
): Promise<string> {
  if (!code.trim()) throw new Error("The Python code was empty.");
  if (code.length > 40_000) throw new Error("The Python code is too long.");
  const safeChatId = safePathSegment(chatId);
  const sandbox = getUserSandbox(env, userId, "python");
  const workspace = `/workspace/python-chats/${safeChatId}`;
  const durableWorkspace = `/workspace/data/chats/${safeChatId}/python`;

  const { context, status } = await getOrCreatePythonContext(sandbox, contextStore, env, userId, chatId, workspace);
  const cellName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.py`;
  const cellPath = `${durableWorkspace}/cells/${cellName}`;
  await env.WORKSPACES.put(`users/${userId}/workspace/chats/${safeChatId}/python/cells/${cellName}`, `${code.trimEnd()}\n`, {
    httpMetadata: { contentType: "text/x-python; charset=utf-8" },
    customMetadata: { chatId, kind: "python-cell" },
  });
  const result = await sandbox.runCode(code, { context, timeout: 120_000 });
  const output = formatPythonExecution(result);
  if (result.error) throw new Error(`${pythonSessionHeader(status, result.executionCount, cellPath)}\n${output}`);
  return `${pythonSessionHeader(status, result.executionCount, cellPath)}\n${output}`.slice(0, MAX_TOOL_OUTPUT);
}

async function getOrCreatePythonContext(
  sandbox: ReturnType<typeof getSandbox>,
  contextStore: PythonContextStore,
  env: Env,
  userId: string,
  chatId: string,
  workspace: string,
): Promise<{ context: CodeContext; status: "warm" | "new" | "restored" }> {
  const key = `${PYTHON_CONTEXT_PREFIX}${chatId}`;
  const storedId = await contextStore.get<string>(key);
  const active = await sandbox.listCodeContexts();
  const existing = storedId ? active.find((context) => context.id === storedId && context.language === "python") : undefined;
  if (existing) return { context: existing, status: "warm" };
  try {
    await ensurePersistentWorkspace(sandbox, env, userId);
  } catch (error) {
    console.warn(JSON.stringify({ event: "eva.python.workspace_mount.unavailable", user: userId.slice(0, 12), error: error instanceof Error ? error.message : "mount failed" }));
  }
  await sandbox.mkdir(workspace, { recursive: true });
  const context = await sandbox.createCodeContext({ language: "python", cwd: workspace, timeout: 30_000 });
  await contextStore.put(key, context.id);
  return { context, status: storedId ? "restored" : "new" };
}

function pythonSessionHeader(status: "warm" | "new" | "restored", executionCount: number | undefined, cellPath: string): string {
  const state = status === "restored"
    ? "restored after the previous live variables expired; durable workspace files are still available"
    : status === "warm" ? "warm; prior variables and imports in this chat are available" : "new";
  const count = executionCount ? `; execution ${executionCount}` : "";
  return `[Python session: ${state}${count}; cell saved to ${cellPath}]`;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
  if (!safe) throw new Error("The chat identifier is not valid for a Python workspace.");
  return safe;
}

function getUserSandbox(env: Env, userId: string, workload: "bash" | "python") {
  return getSandbox(env.Sandbox, `eva-tools-v3-${userId.slice(0, 32)}`, {
    sleepAfter: "10m",
    labels: { application: "eva", workload, user: userId.slice(0, 12) },
  });
}

async function ensurePersistentWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  userId: string,
): Promise<void> {
  const mounted = await sandbox.exec("mountpoint -q /workspace/data", { timeout: 10_000 });
  if (mounted.success) return;
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
