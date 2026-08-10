import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Brain,
  CalendarBlank,
  CaretDown,
  ChatCircleDots,
  CheckCircle,
  Circle,
  Cloud,
  Code,
  Eye,
  EyeSlash,
  GlobeHemisphereWest,
  Info,
  Moon,
  Plus,
  SidebarSimple,
  Sparkle,
  Stop,
  Sun,
  TerminalWindow,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  command,
  type Chat,
  type ChatMessage,
  type ChatSummary,
  type AgentSettings,
  type Memory,
  type MemoryKind,
  type ThinkingLevel,
  type ServerEvent,
  type ToolCall,
} from "../../../../../packages/protocol/src/index";
import { configuredRuntime, EvaClient, saveCloudConfiguration, type EvaRuntime } from "./eva-client";
import evaLogo from "./assets/eva-app-icon.png";

export function App() {
  const clientRef = useRef<EvaClient | undefined>(undefined);
  const activeChatRef = useRef<string | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<Chat>();
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [agentMode, setAgentMode] = useState<"pi" | "fake" | "cloud">("pi");
  const [error, setError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [runtime] = useState<EvaRuntime>(() => configuredRuntime());
  const [authenticationRequired, setAuthenticationRequired] = useState(() => configuredRuntime() === "cloud" && !localStorage.getItem("eva-cloud-token") && location.hostname.endsWith(".workers.dev"));
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("eva-theme") === "light" ? "light" : "dark");
  const [showToolCalls, setShowToolCalls] = useState(() => localStorage.getItem("eva-show-tool-calls") !== "false");

  useEffect(() => {
    document.documentElement.dataset.platform = window.eva?.platform ?? "web";
    const client = new EvaClient();
    clientRef.current = client;
    const removeEvent = client.onEvent((event) => handleEvent(event, client));
    const removeConnection = client.onConnection(setConnected);
    const removeAuthentication = client.onAuthenticationRequired(() => setAuthenticationRequired(true));
    const removeServerError = window.eva?.onServerError(setError);
    const removeTrayNewChat = window.eva?.onNewChat(() => client.send(command("chat.create", {})));
    void client.connect().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not connect"));
    return () => {
      removeEvent();
      removeConnection();
      removeAuthentication();
      removeServerError?.();
      removeTrayNewChat?.();
      client.close();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("eva-theme", theme);
    window.eva?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("eva-show-tool-calls", String(showToolCalls));
  }, [showToolCalls]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [activeChat?.messages, activeChat?.toolCalls]);

  function handleEvent(event: ServerEvent, client: EvaClient): void {
    switch (event.type) {
      case "server.hello":
        setAgentMode(event.payload.agentMode);
        break;
      case "chat.list": {
        setChats(event.payload.chats);
        setActiveChat((current) => {
          if (!current) return current;
          const updated = event.payload.chats.find((chat) => chat.id === current.id);
          return updated ? { ...current, title: updated.title, updatedAt: updated.updatedAt } : current;
        });
        if (!activeChatRef.current) {
          const first = event.payload.chats[0];
          if (first) openChat(first.id, client);
          else client.send(command("chat.create", {}));
        }
        break;
      }
      case "chat.created":
        setChats((current) => [summary(event.payload.chat), ...current.filter((chat) => chat.id !== event.payload.chat.id)]);
        selectSnapshot(event.payload.chat);
        break;
      case "chat.snapshot":
        selectSnapshot(event.payload.chat);
        break;
      case "message.append":
        if (event.payload.chatId === activeChatRef.current) {
          setActiveChat((chat) => chat && ({ ...chat, messages: [...chat.messages, event.payload.message] }));
        }
        break;
      case "assistant.delta":
        if (event.payload.chatId === activeChatRef.current) {
          setActiveChat((chat) => chat && ({
            ...chat,
            messages: chat.messages.map((message) => message.id === event.payload.messageId
              ? { ...message, content: message.content + event.payload.delta }
              : message),
          }));
        }
        break;
      case "tool.call":
        if (event.payload.chatId === activeChatRef.current) {
          setActiveChat((chat) => chat && ({ ...chat, toolCalls: [...chat.toolCalls, event.payload.toolCall] }));
        }
        break;
      case "tool.update":
        if (event.payload.chatId === activeChatRef.current) {
          setActiveChat((chat) => chat && ({
            ...chat,
            toolCalls: chat.toolCalls.map((toolCall) => toolCall.id === event.payload.toolCall.id ? event.payload.toolCall : toolCall),
          }));
        }
        break;
      case "run.status":
        setRunning(event.payload.status === "running");
        if (event.payload.status === "error") setError("The model could not complete that response.");
        break;
      case "settings.snapshot":
      case "settings.updated":
        setSettings(event.payload.settings);
        break;
      case "memory.snapshot":
        setMemories(event.payload.memories);
        break;
      case "memory.updated":
        setMemories((current) => [event.payload.memory, ...current.filter((memory) => memory.id !== event.payload.memory.id)]);
        break;
      case "memory.deleted":
        setMemories((current) => current.filter((memory) => memory.id !== event.payload.memoryId));
        break;
      case "server.error":
        setError(event.payload.message);
        break;
    }
  }

  function selectSnapshot(chat: Chat): void {
    activeChatRef.current = chat.id;
    setActiveChat(chat);
    setError(undefined);
  }

  function openChat(chatId: string, client = clientRef.current): void {
    if (!client || running) return;
    activeChatRef.current = chatId;
    client.send(command("chat.open", { chatId }));
    setSidebarOpen(false);
  }

  function createChat(): void {
    if (running) return;
    clientRef.current?.send(command("chat.create", {}));
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !activeChat || running) return;
    setDraft("");
    setError(undefined);
    clientRef.current?.send(command("message.send", { chatId: activeChat.id, content }));
  }

  function stop(): void {
    if (activeChat) clientRef.current?.send(command("run.abort", { chatId: activeChat.id }));
  }

  return (
    <div className="app-shell">
      {authenticationRequired && (
        <CloudLogin
          onConnect={(endpoint, token) => {
            saveCloudConfiguration(endpoint, token);
            location.reload();
          }}
        />
      )}
      <header className="floating-header">
        <div className="window-controls" aria-label="Window controls">
          <button onClick={() => window.eva?.windowAction("close")} aria-label="Close"><Circle weight="fill" /></button>
          <button onClick={() => window.eva?.windowAction("minimize")} aria-label="Minimize"><Circle weight="fill" /></button>
          <button onClick={() => window.eva?.windowAction("maximize")} aria-label="Maximize"><Circle weight="fill" /></button>
        </div>
        <button className="header-icon sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} aria-label="Toggle chats">
          <SidebarSimple weight="regular" />
        </button>
        <button className="chat-title-pill" onClick={createChat} disabled={running} title="Start a new chat">
          {activeChat?.title === "New chat" ? "New Chat" : activeChat?.title ?? "New Chat"}
        </button>
        <div className="header-actions">
          <button className="header-icon" onClick={createChat} disabled={running} aria-label="New chat"><Plus weight="bold" /></button>
          <button className="header-icon caret" onClick={() => setSidebarOpen((value) => !value)} aria-label="Show chats"><CaretDown weight="bold" /></button>
        </div>
      </header>

      {sidebarOpen && (
        <aside className="chat-drawer">
          <div className="drawer-heading"><span>Chats</span><button onClick={createChat} disabled={running}><Plus weight="bold" /> New</button></div>
          <nav className="chat-list" aria-label="Chats">
            {chats.map((chat) => (
              <button
                key={chat.id}
                className={chat.id === activeChat?.id ? "chat-item active" : "chat-item"}
                onClick={() => openChat(chat.id)}
                disabled={running && chat.id !== activeChat?.id}
              >
                <ChatCircleDots weight="regular" />
                <span>{chat.title}</span>
                <time>{relativeDate(chat.updatedAt)}</time>
              </button>
            ))}
          </nav>
        </aside>
      )}

      <main className="conversation">
          <div className="transcript" ref={transcriptRef}>
            {!activeChat?.messages.length ? <EmptyState /> : activeChat.messages.map((message) => (
              <div className="timeline-group" key={message.id}>
                {message.role === "assistant" && showToolCalls && activeChat.toolCalls
                  .filter((toolCall) => toolCall.assistantMessageId === message.id)
                  .map((toolCall) => (
                    <ToolCallRow
                      key={toolCall.id}
                      toolCall={toolCall}
                      onApprove={() => clientRef.current?.send(command("tool.approve", { toolCallId: toolCall.id }))}
                      onReject={() => clientRef.current?.send(command("tool.reject", { toolCallId: toolCall.id }))}
                    />
                  ))}
                <Message message={message} />
              </div>
            ))}
          </div>

          <div className="composer-wrap">
            {settingsOpen && settings && (
              <SettingsPopover
                settings={settings}
                disabled={running}
                theme={theme}
                onThemeChange={setTheme}
                showToolCalls={showToolCalls}
                onShowToolCallsChange={setShowToolCalls}
                memories={memories}
                runtime={runtime}
                onRuntimeChange={(nextRuntime) => {
                  localStorage.setItem("eva-runtime", nextRuntime);
                  location.reload();
                }}
                onMemoryCreate={(kind, content) => clientRef.current?.send(command("memory.create", { kind, content, importance: 5 }))}
                onMemoryUpdate={(memory) => clientRef.current?.send(command("memory.update", {
                  memoryId: memory.id,
                  kind: memory.kind,
                  content: memory.content,
                  importance: memory.importance,
                  status: memory.status,
                }))}
                onMemoryDelete={(memoryId) => clientRef.current?.send(command("memory.delete", { memoryId }))}
                onClose={() => setSettingsOpen(false)}
                onApply={(next) => {
                  clientRef.current?.send(command("settings.update", {
                    provider: next.selectedModel.provider,
                    modelId: next.selectedModel.id,
                    thinkingLevel: next.thinkingLevel,
                    systemInstructions: next.systemInstructions,
                  }));
                  setSettings(next);
                  setSettingsOpen(false);
                }}
              />
            )}
            {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(undefined)}>Dismiss</button></div>}
            <form className="composer" onSubmit={submit}>
              <button type="button" className="composer-plus" onClick={() => setSidebarOpen(true)} aria-label="Open chats"><Plus weight="bold" /></button>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Ask Eva anything…"
                rows={1}
                disabled={!connected}
                autoFocus
                aria-label="Message Eva"
              />
              {running
                ? <button type="button" className="send stop" onClick={stop} aria-label="Stop response"><Stop weight="fill" /></button>
                : <button type="submit" className="send" disabled={!draft.trim() || !connected} aria-label="Send message"><ArrowUp weight="bold" /></button>}
            </form>
            <div className="composer-meta">
              <button
                type="button"
                className={settingsOpen ? "model-trigger active" : "model-trigger"}
                onClick={() => setSettingsOpen((value) => !value)}
                disabled={!settings || !connected}
                aria-expanded={settingsOpen}
                aria-label="Choose model and assistant settings"
              >
                <img className="eva-model-icon" src={evaLogo} alt="" />
                <span>{settings ? selectedModelName(settings) : connected ? `${agentMode === "fake" ? "Demo" : agentMode === "cloud" ? "Cloud" : "Pi"} ready` : "Connecting…"}</span>
                <CaretDown weight="bold" />
              </button>
              <span>{window.eva ? `${window.eva.platform === "darwin" ? "⌘⇧Space" : "Ctrl+Shift+Space"} to hide` : agentMode === "cloud" ? "Private cloud session" : "Browser preview"}</span>
            </div>
          </div>
      </main>
    </div>
  );
}

function CloudLogin({ onConnect }: { onConnect: (endpoint: string, token: string) => void }) {
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem("eva-cloud-endpoint") || location.origin);
  const [token, setToken] = useState("");
  return (
    <div className="cloud-login-backdrop">
      <form
        className="cloud-login"
        onSubmit={(event) => {
          event.preventDefault();
          if (endpoint.trim() && token.trim()) onConnect(endpoint, token);
        }}
      >
        <img src={evaLogo} alt="" />
        <h1>Connect to Eva Cloud</h1>
        <p>Enter the private access token created during deployment. It stays on this device.</p>
        <label><span>Cloud endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} type="url" required /></label>
        <label><span>Access token</span><input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="current-password" required autoFocus /></label>
        <button type="submit" disabled={!endpoint.trim() || !token.trim()}><Cloud weight="fill" /> Connect securely</button>
      </form>
    </div>
  );
}

function SettingsPopover({
  settings,
  disabled,
  theme,
  onThemeChange,
  showToolCalls,
  onShowToolCallsChange,
  memories,
  runtime,
  onRuntimeChange,
  onMemoryCreate,
  onMemoryUpdate,
  onMemoryDelete,
  onClose,
  onApply,
}: {
  settings: AgentSettings;
  disabled: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  showToolCalls: boolean;
  onShowToolCallsChange: (show: boolean) => void;
  memories: Memory[];
  runtime: EvaRuntime;
  onRuntimeChange: (runtime: EvaRuntime) => void;
  onMemoryCreate: (kind: MemoryKind, content: string) => void;
  onMemoryUpdate: (memory: Memory) => void;
  onMemoryDelete: (memoryId: string) => void;
  onClose: () => void;
  onApply: (settings: AgentSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryKind, setMemoryKind] = useState<MemoryKind>("preference");
  const panelRef = useRef<HTMLDivElement>(null);
  const providers = useMemo(() => {
    const grouped = new Map<string, AgentSettings["models"]>();
    for (const model of draft.models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    return [...grouped.entries()];
  }, [draft.models]);
  const selected = draft.models.find((model) => model.provider === draft.selectedModel.provider && model.id === draft.selectedModel.id);
  const changed = JSON.stringify({ ...draft, models: undefined }) !== JSON.stringify({ ...settings, models: undefined });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !(target instanceof Element && target.closest(".model-trigger"))) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div className="settings-popover" ref={panelRef} role="dialog" aria-label="Assistant settings">
      <div className="settings-heading">
        <div><img className="eva-settings-icon" src={evaLogo} alt="" /><span>Assistant Settings</span></div>
        <span>{draft.models.length} models</span>
      </div>

      <label className="settings-field">
        <span>Model</span>
        <div className="select-wrap">
          <Brain weight="fill" />
          <select
            value={`${draft.selectedModel.provider}/${draft.selectedModel.id}`}
            onChange={(event) => {
              const model = draft.models.find((item) => `${item.provider}/${item.id}` === event.target.value);
              if (!model) return;
              setDraft((current) => ({
                ...current,
                selectedModel: { provider: model.provider, id: model.id },
                thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0] ?? "off",
              }));
            }}
          >
            {providers.map(([provider, models]) => (
              <optgroup key={provider} label={formatProvider(provider)}>
                {models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
              </optgroup>
            ))}
          </select>
          <CaretDown weight="bold" />
        </div>
        {selected?.contextWindow && <small>{formatProvider(selected.provider)} · {formatContext(selected.contextWindow)} context</small>}
      </label>

      <label className="settings-field">
        <span>System Instructions</span>
        <textarea
          rows={4}
          value={draft.systemInstructions}
          onChange={(event) => setDraft((current) => ({ ...current, systemInstructions: event.target.value }))}
          placeholder="Pass additional instructions to Eva, for example tone, role, or output format."
        />
      </label>

      <label className="settings-field">
        <span className="field-title">Reasoning Effort <Info weight="bold" aria-label="Available levels depend on the selected model" /></span>
        <div className="select-wrap effort">
          <Brain weight="regular" />
          <select
            value={draft.thinkingLevel}
            onChange={(event) => setDraft((current) => ({ ...current, thinkingLevel: event.target.value as ThinkingLevel }))}
          >
            {(selected?.thinkingLevels ?? ["off"]).map((level) => <option key={level} value={level}>{formatThinkingLevel(level)}</option>)}
          </select>
          <CaretDown weight="bold" />
        </div>
      </label>

      <div className="appearance-field">
        <span>Appearance</span>
        <div className="theme-switch" role="group" aria-label="Appearance">
          <button type="button" className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")} aria-pressed={theme === "light"}>
            <Sun weight="fill" /> Light
          </button>
          <button type="button" className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")} aria-pressed={theme === "dark"}>
            <Moon weight="fill" /> Dark
          </button>
        </div>
      </div>

      <div className="appearance-field tool-visibility-field">
        <span>Tool Call Details</span>
        <div className="theme-switch" role="group" aria-label="Tool call details">
          <button type="button" className={showToolCalls ? "active" : ""} onClick={() => onShowToolCallsChange(true)} aria-pressed={showToolCalls}>
            <Eye weight="bold" /> Show
          </button>
          <button type="button" className={!showToolCalls ? "active" : ""} onClick={() => onShowToolCallsChange(false)} aria-pressed={!showToolCalls}>
            <EyeSlash weight="bold" /> Hide
          </button>
        </div>
        <small>Shows commands, fetched URLs, output, and completion status in the conversation.</small>
      </div>

      <div className="appearance-field">
        <span>Runtime</span>
        <div className="theme-switch" role="group" aria-label="Eva runtime">
          <button type="button" className={runtime === "local" ? "active" : ""} onClick={() => onRuntimeChange("local")} aria-pressed={runtime === "local"}>
            <TerminalWindow weight="bold" /> This device
          </button>
          <button type="button" className={runtime === "cloud" ? "active" : ""} onClick={() => onRuntimeChange("cloud")} aria-pressed={runtime === "cloud"}>
            <Cloud weight="fill" /> Eva Cloud
          </button>
        </div>
        <small>Cloud mode syncs chats and memory and runs commands in an isolated Cloudflare workspace.</small>
      </div>

      {runtime === "cloud" && (
        <div className="memory-settings">
          <div className="memory-heading"><span>Online Memory</span><strong>{memories.filter((memory) => memory.status === "active").length}</strong></div>
          <div className="memory-create">
            <select value={memoryKind} onChange={(event) => setMemoryKind(event.target.value as MemoryKind)} aria-label="Memory type">
              <option value="preference">Preference</option>
              <option value="profile">Profile</option>
              <option value="project">Project</option>
              <option value="instruction">Instruction</option>
              <option value="fact">Fact</option>
            </select>
            <input value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} placeholder="Something Eva should remember…" maxLength={2000} />
            <button
              type="button"
              disabled={!memoryDraft.trim()}
              onClick={() => {
                onMemoryCreate(memoryKind, memoryDraft.trim());
                setMemoryDraft("");
              }}
              aria-label="Add memory"
            ><Plus weight="bold" /></button>
          </div>
          <div className="memory-list">
            {memories.length ? memories.slice(0, 30).map((memory) => (
              <div className={`memory-item ${memory.status}`} key={memory.id}>
                <button
                  type="button"
                  className="memory-content"
                  onClick={() => onMemoryUpdate({ ...memory, status: memory.status === "active" ? "archived" : "active" })}
                  title={memory.status === "active" ? "Archive memory" : "Restore memory"}
                >
                  <span>{memory.kind}</span>
                  <p>{memory.content}</p>
                </button>
                <button type="button" className="memory-delete" onClick={() => onMemoryDelete(memory.id)} aria-label={`Delete memory: ${memory.content}`}><Trash weight="bold" /></button>
              </div>
            )) : <p className="memory-empty">Eva has no long-term memories yet.</p>}
          </div>
          <small>Click a memory to archive or restore it. Deleted memories are removed from semantic retrieval.</small>
        </div>
      )}

      <div className="settings-footer">
        <span>Model changes apply to the next message</span>
        <button type="button" onClick={() => onApply(draft)} disabled={!changed || disabled}>Apply</button>
      </div>
    </div>
  );
}

function ToolCallRow({ toolCall, onApprove, onReject }: { toolCall: ToolCall; onApprove: () => void; onReject: () => void }) {
  const preview = toolCallPreview(toolCall);
  const isWeb = toolCall.name === "web_fetch";
  const Icon = isWeb ? GlobeHemisphereWest : TerminalWindow;
  const StatusIcon = toolCall.status === "error" || toolCall.status === "rejected" ? WarningCircle : toolCall.status === "complete" ? CheckCircle : Circle;
  return (
    <details className={`tool-call ${toolCall.status}`}>
      <summary>
        <span className="tool-call-icon"><Icon weight="bold" /></span>
        <span className="tool-call-summary">
          <strong>{toolCallLabel(toolCall)}</strong>
          <code>{preview}</code>
        </span>
        <span className="tool-call-status"><StatusIcon weight={toolCall.status === "running" ? "fill" : "bold"} />{formatToolStatus(toolCall.status)}</span>
        <CaretDown className="tool-call-caret" weight="bold" />
      </summary>
      <div className="tool-call-details">
        <div><span>Input</span><pre>{JSON.stringify(toolCall.input, null, 2)}</pre></div>
        <div><span>Output</span><pre>{toolCall.output || (toolCall.status === "running" ? "Waiting for output…" : "No output")}</pre></div>
        {toolCall.status === "pending" && (
          <div className="tool-approval">
            <p>This command will run inside Eva’s isolated cloud workspace.</p>
            <button type="button" className="reject" onClick={onReject}>Reject</button>
            <button type="button" className="approve" onClick={onApprove}>Run command</button>
          </div>
        )}
      </div>
    </details>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>Ask Anything</h2>
      <p>Your personal assistant, available wherever you are.</p>
      <div className="suggestions">
        <button className="suggestion-icon brain" onClick={() => focusWithText("Help me think through an idea")} aria-label="Think through an idea"><Brain weight="fill" /></button>
        <button className="suggestion-icon calendar" onClick={() => focusWithText("Help me plan my day")} aria-label="Plan my day"><CalendarBlank weight="fill" /></button>
        <button className="suggestion-icon code" onClick={() => focusWithText("Help me with a coding task")} aria-label="Help with code"><Code weight="bold" /></button>
        <button className="suggestion-icon sparkle" onClick={() => focusWithText("Give me a fresh idea")} aria-label="Fresh idea"><Sparkle weight="fill" /></button>
      </div>
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{message.role === "user" ? "You" : "Eva"}</div>
      <div className="message-body">
        {message.role === "assistant"
          ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (message.status === "streaming" ? "…" : "")}</ReactMarkdown>
          : <p>{message.content}</p>}
        {message.status === "aborted" && <span className="message-status">Stopped</span>}
        {message.status === "error" && <span className="message-status error">Incomplete</span>}
      </div>
    </article>
  );
}

function toolCallPreview(toolCall: ToolCall): string {
  const value = toolCall.name === "bash" ? toolCall.input.command : toolCall.name === "web_fetch" ? toolCall.input.url : undefined;
  return typeof value === "string" ? value : JSON.stringify(toolCall.input);
}

function toolCallLabel(toolCall: ToolCall): string {
  if (toolCall.name === "bash") return "Ran command";
  if (toolCall.name === "web_fetch") return "Fetched web page";
  return toolCall.name.replace(/[_-]+/g, " ");
}

function formatToolStatus(status: ToolCall["status"]): string {
  if (status === "complete") return "Done";
  if (status === "error") return "Failed";
  if (status === "pending") return "Approval needed";
  if (status === "rejected") return "Rejected";
  return "Running";
}

function focusWithText(value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
}

function summary(chat: Chat): ChatSummary {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
}

function relativeDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function selectedModelName(settings: AgentSettings): string {
  return settings.models.find((model) => model.provider === settings.selectedModel.provider && model.id === settings.selectedModel.id)?.name ?? "Choose model";
}

function formatProvider(provider: string): string {
  return provider.split("-").map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(" ");
}

function formatContext(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M` : `${Math.round(tokens / 1_000)}K`;
}

function formatThinkingLevel(level: ThinkingLevel): string {
  if (level === "off") return "Off";
  if (level === "xhigh") return "Extra High";
  return level[0]!.toUpperCase() + level.slice(1);
}
