import WebSocket from "ws";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.EVA_CLOUD_URL ?? "http://127.0.0.1:8787";
const token = process.env.EVA_CLOUD_TOKEN_FILE
  ? (await readFile(process.env.EVA_CLOUD_TOKEN_FILE, "utf8")).trim()
  : process.env.EVA_CLOUD_TOKEN;
if (!token) throw new Error("Set EVA_CLOUD_TOKEN or EVA_CLOUD_TOKEN_FILE before running the cloud E2E test.");
const timeoutMs = Number(process.env.EVA_E2E_TIMEOUT_MS ?? 90_000);
const bashCommand = process.env.EVA_E2E_KEEP_WORKSPACE_FILE === "1"
  ? "printf EVA_SANDBOX_OK > eva-sandbox-e2e.txt && cat eva-sandbox-e2e.txt"
  : "printf EVA_SANDBOX_OK > eva-sandbox-e2e.txt && cat eva-sandbox-e2e.txt && rm eva-sandbox-e2e.txt";
const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/ws`, ["eva-v1", `eva-token.${token}`]);
const received = [];
const waiters = [];

socket.on("message", (data) => {
  const event = JSON.parse(String(data));
  received.push(event);
  for (const waiter of [...waiters]) {
    if (!waiter.predicate(event)) continue;
    waiters.splice(waiters.indexOf(waiter), 1);
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }
});

socket.on("error", (error) => {
  for (const waiter of waiters.splice(0)) waiter.reject(error);
});

function waitFor(predicate, label) {
  const existing = received.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        const recent = received.slice(-8).map((event) => event.type === "server.error" ? `${event.type}:${event.payload.message}` : event.type).join(", ");
        reject(new Error(`Timed out waiting for ${label}. Recent events: ${recent}`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

function send(type, payload = {}) {
  socket.send(JSON.stringify({ version: 1, requestId: crypto.randomUUID(), type, ...payload }));
}

async function run() {
  await waitFor((event) => event.type === "server.hello", "server hello");

  send("settings.get");
  const settings = await waitFor((event) => event.type === "settings.snapshot", "settings");
  if (settings.payload.settings.selectedModel.provider !== "cloudflare") throw new Error("Cloud model settings were not loaded.");

  send("chat.create");
  const created = await waitFor((event) => event.type === "chat.created", "chat creation");
  const chatId = created.payload.chat.id;

  const marker = `Eva cloud e2e ${Date.now()}`;
  send("memory.create", { kind: "project", content: marker, importance: 3 });
  const memory = await waitFor((event) => event.type === "memory.updated" && event.payload.memory.content === marker, "memory creation");
  send("memory.list");
  const snapshot = await waitFor(
    (event) => event.type === "memory.snapshot" && event.payload.memories.some((item) => item.id === memory.payload.memory.id),
    "persisted memory snapshot",
  );
  if (!snapshot.payload.memories.length) throw new Error("Memory snapshot was empty.");

  received.length = 0;
  send("message.send", { chatId, content: "Reply with exactly: EVA_CLOUD_CHAT_OK" });
  await waitFor((event) => event.type === "run.status" && event.payload.chatId === chatId && event.payload.status === "idle", "chat completion");
  const chatText = received.filter((event) => event.type === "assistant.delta").map((event) => event.payload.delta).join("");
  if (!chatText.includes("EVA_CLOUD_CHAT_OK")) throw new Error(`Unexpected chat response: ${chatText}`);

  received.length = 0;
  send("message.send", {
    chatId,
    content: `Use the bash tool now to run: ${bashCommand}. Do not answer without using the bash tool.`,
  });
  const pending = await waitFor(
    (event) => event.type === "tool.call" && event.payload.toolCall.name === "bash" && event.payload.toolCall.status === "pending",
    "pending Bash approval",
  );
  send("tool.approve", { toolCallId: pending.payload.toolCall.id });
  const completed = await waitFor(
    (event) => event.type === "tool.update" && event.payload.toolCall.id === pending.payload.toolCall.id && event.payload.toolCall.status === "complete",
    "approved Bash execution",
  );
  if (!completed.payload.toolCall.output.includes("EVA_SANDBOX_OK")) throw new Error(`Unexpected Bash output: ${completed.payload.toolCall.output}`);
  await waitFor((event) => event.type === "run.status" && event.payload.chatId === chatId && event.payload.status === "idle", "post-tool completion");

  send("memory.delete", { memoryId: memory.payload.memory.id });
  await waitFor((event) => event.type === "memory.deleted" && event.payload.memoryId === memory.payload.memory.id, "memory cleanup");

  console.log(JSON.stringify({ ok: true, chatId, checks: ["auth", "settings", "chat", "memory", "workers-ai", "bash-approval", "sandbox"] }));
}

try {
  await run();
} finally {
  socket.close();
}
