import WebSocket from "ws";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.EVA_CLOUD_URL ?? "http://127.0.0.1:8787";
const token = process.env.EVA_CLOUD_TOKEN_FILE
  ? (await readFile(process.env.EVA_CLOUD_TOKEN_FILE, "utf8")).trim()
  : process.env.EVA_CLOUD_TOKEN;
if (!token) throw new Error("Set EVA_CLOUD_TOKEN or EVA_CLOUD_TOKEN_FILE before running the cloud E2E test.");
const timeoutMs = Number(process.env.EVA_E2E_TIMEOUT_MS ?? 90_000);
const skipBash = process.env.EVA_E2E_SKIP_BASH === "1";
const bashCommand = process.env.EVA_E2E_KEEP_WORKSPACE_FILE === "1"
  ? "printf EVA_SANDBOX_OK > eva-sandbox-e2e.txt && cat eva-sandbox-e2e.txt"
  : "printf EVA_SANDBOX_OK > eva-sandbox-e2e.txt && cat eva-sandbox-e2e.txt && rm eva-sandbox-e2e.txt";
const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/ws`, ["eva-v2", `eva-token.${token}`]);
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
  socket.send(JSON.stringify({ version: 2, requestId: crypto.randomUUID(), type, ...payload }));
}

async function run() {
  await waitFor((event) => event.type === "server.hello", "server hello");

  send("settings.get");
  const settings = await waitFor((event) => event.type === "settings.snapshot", "settings");
  if (settings.payload.settings.selectedModel.provider !== "cloudflare") throw new Error("Cloud model settings were not loaded.");

  send("memory.list");
  const existingMemory = await waitFor((event) => event.type === "memory.snapshot", "existing memory snapshot");
  for (const item of existingMemory.payload.memories.filter((memory) => memory.content.startsWith("Eva cloud e2e "))) {
    send("memory.delete", { memoryId: item.id });
    await waitFor((event) => event.type === "memory.deleted" && event.payload.memoryId === item.id, "stale memory cleanup");
  }

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

  send("chat.create");
  const recallChat = await waitFor((event) => event.type === "chat.created" && event.payload.chat.id !== chatId, "recall chat creation");
  received.length = 0;
  send("message.send", {
    chatId: recallChat.payload.chat.id,
    content: `What exact long-term memory contains this marker: ${marker}? Reply with the full marker.`,
    routing: "cloud",
  });
  await waitFor(
    (event) => event.type === "run.status" && event.payload.chatId === recallChat.payload.chat.id && event.payload.status === "idle",
    "immediate cross-chat memory recall",
  );
  const recallText = received.filter((event) => event.type === "assistant.delta").map((event) => event.payload.delta).join("");
  if (!recallText.includes(marker)) throw new Error(`Immediate D1 memory recall failed: ${recallText}`);

  send("chat.create");
  const saveChat = await waitFor(
    (event) => event.type === "chat.created" && ![chatId, recallChat.payload.chat.id].includes(event.payload.chat.id),
    "memory save chat creation",
  );
  const saveMarker = `Eva cloud e2e saved ${Date.now()}`;
  received.length = 0;
  send("message.send", {
    chatId: saveChat.payload.chat.id,
    content: `Remember this durable project fact exactly: ${saveMarker}. Use the remember tool and confirm only after it succeeds.`,
    routing: "cloud",
  });
  const savedByAgent = await waitFor(
    (event) => event.type === "memory.updated" && event.payload.memory.content.includes(saveMarker),
    "agent memory write",
  );
  await waitFor(
    (event) => event.type === "run.status" && event.payload.chatId === saveChat.payload.chat.id && event.payload.status === "idle",
    "verified memory receipt",
  );
  const saveText = received.filter((event) => event.type === "assistant.delta").map((event) => event.payload.delta).join("");
  if (!saveText.includes("Memory saved ✓")) throw new Error(`Verified save receipt was missing: ${saveText}`);

  received.length = 0;
  send("message.send", { chatId, content: "Reply with exactly: EVA_CLOUD_CHAT_OK", routing: "cloud" });
  await waitFor((event) => event.type === "run.status" && event.payload.chatId === chatId && event.payload.status === "idle", "chat completion");
  const chatDeltas = received.filter((event) => event.type === "assistant.delta");
  const chatText = chatDeltas.map((event) => event.payload.delta).join("");
  if (!chatText.includes("EVA_CLOUD_CHAT_OK")) throw new Error(`Unexpected chat response: ${chatText}`);
  if (chatDeltas.length < 2) throw new Error(`Workers AI response was not incrementally streamed (${chatDeltas.length} delta).`);

  send("chat.create");
  const concurrentA = await waitFor(
    (event) => event.type === "chat.created" && ![chatId, recallChat.payload.chat.id, saveChat.payload.chat.id].includes(event.payload.chat.id),
    "first concurrent chat",
  );
  send("chat.create");
  const concurrentB = await waitFor(
    (event) => event.type === "chat.created" && ![chatId, recallChat.payload.chat.id, saveChat.payload.chat.id, concurrentA.payload.chat.id].includes(event.payload.chat.id),
    "second concurrent chat",
  );
  received.length = 0;
  send("message.send", {
    chatId: concurrentA.payload.chat.id,
    content: "Write 300 words about distributed systems, ending with EVA_CONCURRENT_A.",
    routing: "cloud",
  });
  send("message.send", {
    chatId: concurrentB.payload.chat.id,
    content: "Reply with exactly: EVA_CONCURRENT_B",
    routing: "cloud",
  });
  await waitFor(
    (event) => event.type === "assistant.delta" && event.payload.chatId === concurrentA.payload.chat.id,
    "first concurrent stream",
  );
  await waitFor(
    (event) => event.type === "run.status" && event.payload.chatId === concurrentB.payload.chat.id && event.payload.status === "running",
    "second concurrent run",
  );
  send("run.abort", { chatId: concurrentA.payload.chat.id });
  await waitFor(
    (event) => event.type === "run.status" && event.payload.chatId === concurrentA.payload.chat.id && event.payload.status === "aborted",
    "scoped concurrent abort",
  );
  await waitFor(
    (event) => event.type === "run.status" && event.payload.chatId === concurrentB.payload.chat.id && event.payload.status === "idle",
    "uninterrupted concurrent completion",
  );
  const concurrentBText = received
    .filter((event) => event.type === "assistant.delta" && event.payload.chatId === concurrentB.payload.chat.id)
    .map((event) => event.payload.delta)
    .join("");
  if (!concurrentBText.includes("EVA_CONCURRENT_B")) throw new Error(`Concurrent chat was interrupted: ${concurrentBText}`);

  if (!skipBash) {
    received.length = 0;
    send("message.send", {
      chatId,
      content: `Use the bash tool now to run: ${bashCommand}. Do not answer without using the bash tool.`,
      routing: "cloud",
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
  }

  send("memory.delete", { memoryId: memory.payload.memory.id });
  await waitFor((event) => event.type === "memory.deleted" && event.payload.memoryId === memory.payload.memory.id, "memory cleanup");
  send("memory.delete", { memoryId: savedByAgent.payload.memory.id });
  await waitFor(
    (event) => event.type === "memory.deleted" && event.payload.memoryId === savedByAgent.payload.memory.id,
    "agent memory cleanup",
  );

  console.log(JSON.stringify({
    ok: true,
    chatId,
    checks: [
      "auth",
      "settings",
      "chat",
      "memory",
      "immediate-cross-chat-recall",
      "verified-save-receipt",
      "workers-ai-stream",
      "concurrent-chats",
      "scoped-abort",
      ...skipBash ? [] : ["bash-approval", "sandbox"],
    ],
  }));
}

try {
  await run();
} finally {
  socket.close();
}
