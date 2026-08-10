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
  type DeviceCapability,
  type Memory,
  type MemoryKind,
  type RoutingPolicy,
  type ThinkingLevel,
  type ServerEvent,
  type ToolCall,
} from "../../../../../packages/protocol/src/index";
import { EvaClient, hasCloudConfiguration, saveCloudConfiguration } from "./eva-client";
import evaLogo from "./assets/eva-app-icon.png";
import {
  appendAssistantDelta,
  appendMessage,
  completeAssistantMessage,
  mergeChatSnapshot,
  upsertToolCall,
} from "./chat-state";

export function App() {
  const clientRef = useRef<EvaClient | undefined>(undefined);
  const activeChatRef = useRef<string | undefined>(undefined);
  const chatCacheRef = useRef(new Map<string, Chat>());
  const chatsRef = useRef<ChatSummary[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<Chat>();
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [runningChats, setRunningChats] = useState<Set<string>>(() => new Set());
  const [agentMode, setAgentMode] = useState<"pi" | "fake" | "cloud" | "hybrid">("pi");
  const [error, setError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [authenticationRequired, setAuthenticationRequired] = useState(() => window.eva ? false : !hasCloudConfiguration());
  const [devices, setDevices] = useState<DeviceCapability[]>([]);
  const [routing, setRouting] = useState<RoutingPolicy>(() => {
    const saved = localStorage.getItem("eva-routing-policy");
    return saved === "cloud" || saved === "device" || saved === "private" ? saved : "auto";
  });
  const [routeStatuses, setRouteStatuses] = useState<Record<string, Extract<ServerEvent, { type: "route.status" }>["payload"]>>({});
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("eva-theme") === "light" ? "light" : "dark");
  const [showToolCalls, setShowToolCalls] = useState(() => localStorage.getItem("eva-show-tool-calls") !== "false");
  const [syncOfflineToolOutput, setSyncOfflineToolOutput] = useState(() => localStorage.getItem("eva-sync-offline-tool-output") === "true");
  const running = activeChat ? runningChats.has(activeChat.id) : false;
  const routeStatus = activeChat ? routeStatuses[activeChat.id] : undefined;

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
    localStorage.setItem("eva-sync-offline-tool-output", String(syncOfflineToolOutput));
  }, [syncOfflineToolOutput]);

  useEffect(() => {
    localStorage.setItem("eva-routing-policy", routing);
  }, [routing]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [activeChat?.messages, activeChat?.toolCalls]);

  function updateCachedChat(chatId: string, update: (chat: Chat) => Chat): void {
    let current = chatCacheRef.current.get(chatId);
    if (!current) {
      const chat = chatsRef.current.find((candidate) => candidate.id === chatId);
      if (!chat) return;
      current = { ...chat, messages: [], toolCalls: [] };
    }
    const next = update(current);
    chatCacheRef.current.set(chatId, next);
    if (activeChatRef.current === chatId) setActiveChat(next);
  }

  function handleEvent(event: ServerEvent, client: EvaClient): void {
    switch (event.type) {
      case "server.hello":
        setAgentMode(event.payload.agentMode);
        break;
      case "chat.list": {
        chatsRef.current = event.payload.chats;
        for (const chat of event.payload.chats) {
          const cached = chatCacheRef.current.get(chat.id);
          if (cached) chatCacheRef.current.set(chat.id, { ...cached, ...chat });
        }
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
        chatsRef.current = [summary(event.payload.chat), ...chatsRef.current.filter((chat) => chat.id !== event.payload.chat.id)];
        setChats(chatsRef.current);
        selectSnapshot(event.payload.chat);
        break;
      case "chat.snapshot":
        selectSnapshot(event.payload.chat);
        break;
      case "message.append":
        updateCachedChat(event.payload.chatId, (chat) => appendMessage(chat, event.payload.message));
        break;
      case "assistant.delta":
        updateCachedChat(event.payload.chatId, (chat) => appendAssistantDelta(chat, event.payload.messageId, event.payload.delta));
        break;
      case "tool.call":
      case "tool.update":
        updateCachedChat(event.payload.chatId, (chat) => upsertToolCall(chat, event.payload.toolCall));
        break;
      case "run.status": {
        setRunningChats((current) => {
          const next = new Set(current);
          if (event.payload.status === "running") next.add(event.payload.chatId);
          else next.delete(event.payload.chatId);
          return next;
        });
        if (event.payload.status === "error" && event.payload.chatId === activeChatRef.current) setError("The model could not complete that response.");
        break;
      }
      case "device.presence":
        setDevices(event.payload.devices);
        break;
      case "route.status":
        setRouteStatuses((current) => ({ ...current, [event.payload.chatId]: event.payload }));
        break;
      case "device.turn.complete":
        updateCachedChat(event.payload.chatId, (chat) => completeAssistantMessage(
          chat,
          event.payload.messageId,
          event.payload.content,
          event.payload.status,
        ));
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
    const merged = mergeChatSnapshot(chatCacheRef.current.get(chat.id), chat);
    chatCacheRef.current.set(chat.id, merged);
    activeChatRef.current = chat.id;
    setActiveChat(merged);
    setRunningChats((current) => {
      const next = new Set(current);
      if (merged.messages.some((message) => message.status === "streaming")) next.add(chat.id);
      else next.delete(chat.id);
      return next;
    });
    setError(undefined);
  }

  function openChat(chatId: string, client = clientRef.current): void {
    if (!client) return;
    activeChatRef.current = chatId;
    const cached = chatCacheRef.current.get(chatId);
    if (cached) setActiveChat(cached);
    client.send(command("chat.open", { chatId }));
    setSidebarOpen(false);
  }

  function createChat(): void {
    clientRef.current?.send(command("chat.create", {}));
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !activeChat || running) return;
    setDraft("");
    setError(undefined);
    clientRef.current?.send(command("message.send", { chatId: activeChat.id, content, routing }));
  }

  function stop(): void {
    if (activeChat) clientRef.current?.send(command("run.abort", { chatId: activeChat.id }));
  }

  return (
    <div className="app-shell">
      {authenticationRequired && (
        <CloudLogin
          onConnect={async (endpoint, token) => {
            await saveCloudConfiguration(endpoint, token);
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
        <button className="chat-title-pill" onClick={createChat} title="Start a new chat">
          {activeChat?.title === "New chat" ? "New Chat" : activeChat?.title ?? "New Chat"}
        </button>
        <div className="header-actions">
          <button className="header-icon" onClick={createChat} aria-label="New chat"><Plus weight="bold" /></button>
          <button className="header-icon caret" onClick={() => setSidebarOpen((value) => !value)} aria-label="Show chats"><CaretDown weight="bold" /></button>
        </div>
      </header>

      {sidebarOpen && (
        <aside className="chat-drawer">
          <div className="drawer-heading"><span>Chats</span><button onClick={createChat}><Plus weight="bold" /> New</button></div>
          <nav className="chat-list" aria-label="Chats">
            {chats.map((chat) => (
              <button
                key={chat.id}
                className={chat.id === activeChat?.id ? "chat-item active" : "chat-item"}
                onClick={() => openChat(chat.id)}
              >
                <ChatCircleDots weight="regular" />
                <span>{chat.title}</span>
                <time>{runningChats.has(chat.id) ? "Running…" : relativeDate(chat.updatedAt)}</time>
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
                disabled={runningChats.size > 0}
                theme={theme}
                onThemeChange={setTheme}
                showToolCalls={showToolCalls}
                onShowToolCallsChange={setShowToolCalls}
                syncOfflineToolOutput={syncOfflineToolOutput}
                onSyncOfflineToolOutputChange={setSyncOfflineToolOutput}
                memories={memories}
                devices={devices}
                routing={routing}
                onRoutingChange={setRouting}
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
              <span>{routeStatus && (routeStatus.status === "queued" || routeStatus.status === "running")
                ? `Running on ${routeStatus.host === "device" ? deviceName(devices, routeStatus.deviceId) : "Eva Cloud"}`
                : window.eva
                  ? `${devices.filter((device) => device.online).length} device${devices.filter((device) => device.online).length === 1 ? "" : "s"} online · ${window.eva.platform === "darwin" ? "⌘⇧Space" : "Ctrl+Shift+Space"}`
                  : agentMode === "hybrid" || agentMode === "cloud" ? "Synced with Eva Cloud" : "Browser preview"}</span>
            </div>
          </div>
      </main>
    </div>
  );
}

function CloudLogin({ onConnect }: { onConnect: (endpoint: string, token: string) => Promise<void> }) {
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem("eva-cloud-endpoint") || (location.protocol.startsWith("http") ? location.origin : "https://eva-cloud.rahulvramesh.workers.dev"));
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState<string>();
  return (
    <div className="cloud-login-backdrop">
      <form
        className="cloud-login"
        onSubmit={(event) => {
          event.preventDefault();
          if (endpoint.trim() && token.trim()) void onConnect(endpoint, token).catch((reason) => {
            setLoginError(reason instanceof Error ? reason.message : "Could not store the cloud credential securely.");
          });
        }}
      >
        <img src={evaLogo} alt="" />
        <h1>Connect to Eva Cloud</h1>
        <p>Enter the private access token created during deployment. It stays on this device.</p>
        <label><span>Cloud endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} type="url" required /></label>
        <label><span>Access token</span><input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="current-password" required autoFocus /></label>
        {loginError && <p className="cloud-login-error" role="alert">{loginError}</p>}
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
  syncOfflineToolOutput,
  onSyncOfflineToolOutputChange,
  memories,
  devices,
  routing,
  onRoutingChange,
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
  syncOfflineToolOutput: boolean;
  onSyncOfflineToolOutputChange: (sync: boolean) => void;
  memories: Memory[];
  devices: DeviceCapability[];
  routing: RoutingPolicy;
  onRoutingChange: (routing: RoutingPolicy) => void;
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
                {models.map((model) => <option key={`${model.provider}/${model.id}/${model.deviceId ?? "cloud"}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.executionHost === "device" ? deviceName(devices, model.deviceId) : "Cloud"}</option>)}
              </optgroup>
            ))}
          </select>
          <CaretDown weight="bold" />
        </div>
        {selected?.contextWindow && <small>{formatProvider(selected.provider)} · {formatContext(selected.contextWindow)} context · {selected.executionHost === "device" ? deviceName(devices, selected.deviceId) : "Eva Cloud"}</small>}
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

      <div className="appearance-field tool-visibility-field">
        <span>Offline Tool Output Sync</span>
        <div className="theme-switch" role="group" aria-label="Offline tool output sync">
          <button type="button" className={!syncOfflineToolOutput ? "active" : ""} onClick={() => onSyncOfflineToolOutputChange(false)} aria-pressed={!syncOfflineToolOutput}>
            <EyeSlash weight="bold" /> Keep local
          </button>
          <button type="button" className={syncOfflineToolOutput ? "active" : ""} onClick={() => onSyncOfflineToolOutputChange(true)} aria-pressed={syncOfflineToolOutput}>
            <Cloud weight="fill" /> Sync output
          </button>
        </div>
        <small>Chat responses always sync after reconnect. Command output stays on the device by default to reduce accidental data exposure.</small>
      </div>

      <div className="appearance-field">
        <span>Execution</span>
        <div className="route-grid" role="group" aria-label="Execution preference">
          <button type="button" className={routing === "auto" ? "active" : ""} onClick={() => onRoutingChange("auto")} aria-pressed={routing === "auto"}>
            <Sparkle weight="fill" /> Auto
          </button>
          <button type="button" className={routing === "cloud" ? "active" : ""} onClick={() => onRoutingChange("cloud")} aria-pressed={routing === "cloud"}>
            <Cloud weight="fill" /> Cloud
          </button>
          <button type="button" className={routing === "device" ? "active" : ""} onClick={() => onRoutingChange("device")} aria-pressed={routing === "device"}>
            <TerminalWindow weight="bold" /> This device
          </button>
          <button type="button" className={routing === "private" ? "active" : ""} onClick={() => onRoutingChange("private")} aria-pressed={routing === "private"}>
            <EyeSlash weight="bold" /> Private
          </button>
        </div>
        <small>{routingDescription(routing)}</small>
        <div className="device-list">
          {devices.length ? devices.map((device) => (
            <div key={device.id} className={device.online ? "device online" : "device"}>
              <Circle weight="fill" />
              <span>{device.name}</span>
              <small>{device.online ? `${device.models.length} models · Bash and files ready` : "Offline"}</small>
            </div>
          )) : <div className="device"><Circle weight="fill" /><span>No device connected</span><small>Cloud-only tasks remain available</small></div>}
        </div>
      </div>

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

function deviceName(devices: DeviceCapability[], deviceId?: string): string {
  if (!deviceId) return "this device";
  return devices.find((device) => device.id === deviceId)?.name ?? "this device";
}

function routingDescription(routing: RoutingPolicy): string {
  if (routing === "cloud") return "Use Eva Cloud for this chat unless you change it.";
  if (routing === "device") return "Run the next turns through Pi and tools on your connected device.";
  if (routing === "private") return "Keep execution on your device. Eva will not silently fall back to cloud execution.";
  return "Eva chooses the safest capable host. File and shell work stays on your device; other tasks use cloud by default.";
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
