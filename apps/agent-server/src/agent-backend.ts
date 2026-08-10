import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModel, AgentSettings, Chat, ThinkingLevel } from "../../../packages/protocol/src/index.js";
import { createEvaTools } from "./agent-tools.js";

type SettingsUpdate = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  systemInstructions: string;
};

export type ToolActivity =
  | { phase: "start"; id: string; name: string; input: Record<string, unknown> }
  | { phase: "update"; id: string; output: string }
  | { phase: "end"; id: string; output: string; isError: boolean };

export interface AgentBackend {
  readonly mode: "pi" | "fake";
  getSettings(): Promise<AgentSettings>;
  updateSettings(update: SettingsUpdate): Promise<AgentSettings>;
  generate(chat: Chat, prompt: string, onDelta: (delta: string) => void, onToolActivity: (activity: ToolActivity) => void): Promise<{ sessionFile?: string }>;
  abort(chatId: string): Promise<void>;
  dispose(): Promise<void>;
}

export class FakeAgentBackend implements AgentBackend {
  readonly mode = "fake" as const;
  private controllers = new Map<string, AbortController>();
  private settings: AgentSettings = {
    models: [
      { provider: "demo", id: "eva-mini", name: "Eva Mini", contextWindow: 64_000, thinkingLevels: ["off", "low", "medium", "high"] },
      { provider: "demo", id: "eva-reasoning", name: "Eva Reasoning", contextWindow: 128_000, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
      { provider: "demo", id: "eva-fast", name: "Eva Fast", contextWindow: 32_000, thinkingLevels: ["off"] },
    ],
    selectedModel: { provider: "demo", id: "eva-mini" },
    thinkingLevel: "medium",
    systemInstructions: "",
  };

  async getSettings(): Promise<AgentSettings> {
    return structuredClone(this.settings);
  }

  async updateSettings(update: SettingsUpdate): Promise<AgentSettings> {
    const model = this.settings.models.find((item) => item.provider === update.provider && item.id === update.modelId);
    if (!model) throw new Error("That model is no longer available.");
    this.settings = {
      ...this.settings,
      selectedModel: { provider: model.provider, id: model.id },
      thinkingLevel: clampThinkingLevel(update.thinkingLevel, model.thinkingLevels),
      systemInstructions: update.systemInstructions.trim(),
    };
    return structuredClone(this.settings);
  }

  async generate(chat: Chat, prompt: string, onDelta: (delta: string) => void, onToolActivity: (activity: ToolActivity) => void): Promise<object> {
    const controller = new AbortController();
    this.controllers.set(chat.id, controller);
    const demoTool = /\b(tool|command|installed|claude)\b/i.test(prompt);
    const demoPlan = /\b(plan|steps)\b/i.test(prompt);
    const response = demoTool
      ? "I checked the command and confirmed the local installation details."
      : `I’m Eva. You said: “${prompt}”`;
    try {
      if (demoTool) {
        const id = `demo-${crypto.randomUUID()}`;
        onToolActivity({ phase: "start", id, name: "bash", input: { command: "command -v claude && claude --version" } });
        await new Promise((resolve) => setTimeout(resolve, 180));
        const output = "/Users/eva/.local/bin/claude\n2.1.222";
        onToolActivity({ phase: "update", id, output });
        onToolActivity({ phase: "end", id, output, isError: false });
      }
      if (demoPlan) {
        const id = `demo-${crypto.randomUUID()}`;
        const input = { title: "Eva plan", steps: [{ id: "understand", label: "Understand the request", status: "complete" }, { id: "deliver", label: "Deliver the result", status: "running" }] };
        onToolActivity({ phase: "start", id, name: "present_plan", input });
        onToolActivity({ phase: "end", id, output: "Presented plan in Eva.", isError: false });
      }
      for (const token of response.split(/(?<=\s)/)) {
        if (controller.signal.aborted) throw new Error("ABORTED");
        onDelta(token);
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
      return {};
    } finally {
      this.controllers.delete(chat.id);
    }
  }

  async abort(chatId: string): Promise<void> {
    this.controllers.get(chatId)?.abort();
  }

  async dispose(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

type PiSession = {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: PiEvent) => void): () => void;
  sessionFile?: string;
};

type PiEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
};

export class PiAgentBackend implements AgentBackend {
  readonly mode = "pi" as const;
  private sessions = new Map<string, PiSession>();
  private runtimePromise?: Promise<ModelRuntime>;
  private settingsPromise?: Promise<AgentSettings>;

  constructor(private readonly dataDir: string, private readonly workspace: string) {}

  async getSettings(): Promise<AgentSettings> {
    if (!this.settingsPromise) this.settingsPromise = this.loadSettings();
    return structuredClone(await this.settingsPromise);
  }

  async updateSettings(update: SettingsUpdate): Promise<AgentSettings> {
    const current = await this.getSettings();
    const model = current.models.find((item) => item.provider === update.provider && item.id === update.modelId);
    if (!model) throw new Error("That model is no longer available.");
    const next: AgentSettings = {
      ...current,
      selectedModel: { provider: model.provider, id: model.id },
      thinkingLevel: clampThinkingLevel(update.thinkingLevel, model.thinkingLevels),
      systemInstructions: update.systemInstructions.trim(),
    };
    await this.writeSettings(next);
    this.settingsPromise = Promise.resolve(next);
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    return structuredClone(next);
  }

  async generate(chat: Chat, prompt: string, onDelta: (delta: string) => void, onToolActivity: (activity: ToolActivity) => void): Promise<{ sessionFile?: string }> {
    const session = await this.getSession(chat);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        onDelta(event.assistantMessageEvent.delta ?? "");
      }
      if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
        onToolActivity({ phase: "start", id: event.toolCallId, name: event.toolName, input: serializableRecord(event.args) });
      }
      if (event.type === "tool_execution_update" && event.toolCallId) {
        onToolActivity({ phase: "update", id: event.toolCallId, output: toolOutput(event.partialResult) });
      }
      if (event.type === "tool_execution_end" && event.toolCallId) {
        onToolActivity({ phase: "end", id: event.toolCallId, output: toolOutput(event.result), isError: Boolean(event.isError) });
      }
    });
    try {
      await session.prompt(prompt);
      return { sessionFile: session.sessionFile };
    } finally {
      unsubscribe();
    }
  }

  async abort(chatId: string): Promise<void> {
    await this.sessions.get(chatId)?.abort();
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private async getSession(chat: Chat): Promise<PiSession> {
    const existing = this.sessions.get(chat.id);
    if (existing) return existing;

    await mkdir(this.workspace, { recursive: true });
    await mkdir(join(this.dataDir, "pi-sessions"), { recursive: true });
    process.env.PI_CODING_AGENT_SESSION_DIR = join(this.dataDir, "pi-sessions");

    const pi = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await this.getRuntime();
    const settings = await this.getSettings();
    const model = modelRuntime.getModel(settings.selectedModel.provider, settings.selectedModel.id);
    if (!model) throw new Error("The selected Pi model is no longer available.");
    const sessionManager = chat.sessionFile
      ? pi.SessionManager.open(chat.sessionFile)
      : pi.SessionManager.create(this.workspace);
    const agentDir = join(this.dataDir, "pi-agent");
    await mkdir(agentDir, { recursive: true });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: this.workspace,
      agentDir,
      appendSystemPrompt: settings.systemInstructions ? [settings.systemInstructions] : [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const result = await pi.createAgentSession({
      cwd: this.workspace,
      sessionManager,
      modelRuntime,
      model,
      thinkingLevel: settings.thinkingLevel,
      resourceLoader,
      noTools: "builtin",
      customTools: createEvaTools(this.workspace),
    });
    const session = result.session as PiSession;
    this.sessions.set(chat.id, session);
    return session;
  }

  private async getRuntime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) this.runtimePromise = import("@earendil-works/pi-coding-agent").then((pi) => pi.ModelRuntime.create());
    return this.runtimePromise;
  }

  private async loadSettings(): Promise<AgentSettings> {
    const runtime = await this.getRuntime();
    const available = await runtime.getAvailable();
    const models: AgentModel[] = available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      thinkingLevels: supportedThinkingLevels(model),
      localInference: isLocalInferenceProvider(model.provider),
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    if (!models.length) throw new Error("No configured Pi models are available. Configure a provider in Pi first.");

    let saved: Partial<SettingsUpdate> = {};
    try {
      saved = JSON.parse(await readFile(this.settingsPath, "utf8")) as Partial<SettingsUpdate>;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const selected = models.find((model) => model.provider === saved.provider && model.id === saved.modelId) ?? models[0]!;
    return {
      models,
      selectedModel: { provider: selected.provider, id: selected.id },
      thinkingLevel: clampThinkingLevel(saved.thinkingLevel ?? "medium", selected.thinkingLevels),
      systemInstructions: typeof saved.systemInstructions === "string" ? saved.systemInstructions : "",
    };
  }

  private get settingsPath(): string {
    return join(this.dataDir, "agent-settings.json");
  }

  private async writeSettings(settings: AgentSettings): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.settingsPath}.tmp`;
    await writeFile(temporary, JSON.stringify({
      provider: settings.selectedModel.provider,
      modelId: settings.selectedModel.id,
      thinkingLevel: settings.thinkingLevel,
      systemInstructions: settings.systemInstructions,
    }, null, 2), "utf8");
    await rename(temporary, this.settingsPath);
  }
}

function isLocalInferenceProvider(provider: string): boolean {
  return /^(ollama|lmstudio|lm-studio|local|llamacpp|llama-cpp|vllm)$/i.test(provider);
}

function serializableRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toolOutput(value: unknown): string {
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    return value.content
      .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && item.type === "text" && typeof item.text === "string"))
      .map((item) => item.text)
      .join("\n")
      .slice(0, 200_000);
  }
  if (typeof value === "string") return value.slice(0, 200_000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 200_000);
  } catch {
    return "";
  }
}

type PiModelMetadata = {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

function supportedThinkingLevels(model: PiModelMetadata): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return level === "xhigh" || level === "max" ? mapped !== undefined && mapped !== null : mapped !== null;
  });
}

function clampThinkingLevel(level: ThinkingLevel, supported: ThinkingLevel[]): ThinkingLevel {
  if (supported.includes(level)) return level;
  const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const requested = order.indexOf(level);
  return [...order.slice(requested), ...order.slice(0, requested).reverse()].find((candidate) => supported.includes(candidate)) ?? supported[0] ?? "off";
}
