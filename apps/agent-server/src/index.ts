import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { AgentServer } from "./server.js";
import { ChatRepository } from "./chat-repository.js";
import { FakeAgentBackend, PiAgentBackend } from "./agent-backend.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.EVA_PORT ?? "0", 10);
const token = process.env.EVA_TOKEN ?? randomBytes(32).toString("hex");
const dataDir = resolve(process.env.EVA_DATA_DIR ?? ".eva-data");
const workspace = resolve(process.env.EVA_WORKSPACE ?? `${dataDir}/workspace`);
const mode = process.env.EVA_AGENT_MODE === "fake" ? "fake" : "pi";

const server = new AgentServer({
  host,
  port,
  token,
  repository: new ChatRepository(dataDir),
  backend: mode === "fake" ? new FakeAgentBackend() : new PiAgentBackend(dataDir, workspace),
});

const actualPort = await server.listen();
process.send?.({ type: "ready", port: actualPort });
if (!process.send) console.log(`EVA_READY ${actualPort} ${token}`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
