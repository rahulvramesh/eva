import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Brain,
  CalendarBlank,
  CaretDown,
  ChatCircleDots,
  Circle,
  Code,
  Info,
  Moon,
  Plus,
  SidebarSimple,
  Sparkle,
  Stop,
  Sun,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  command,
  type Chat,
  type ChatMessage,
  type ChatSummary,
  type AgentSettings,
  type ThinkingLevel,
  type ServerEvent,
} from "../../../../../packages/protocol/src/index";
import { EvaClient } from "./eva-client";
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
  const [agentMode, setAgentMode] = useState<"pi" | "fake">("pi");
  const [error, setError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>();
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("eva-theme") === "light" ? "light" : "dark");

  useEffect(() => {
    document.documentElement.dataset.platform = window.eva?.platform ?? "web";
    const client = new EvaClient();
    clientRef.current = client;
    const removeEvent = client.onEvent((event) => handleEvent(event, client));
    const removeConnection = client.onConnection(setConnected);
    const removeServerError = window.eva?.onServerError(setError);
    void client.connect().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not connect"));
    return () => {
      removeEvent();
      removeConnection();
      removeServerError?.();
      client.close();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("eva-theme", theme);
    window.eva?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [activeChat?.messages]);

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
      case "run.status":
        setRunning(event.payload.status === "running");
        if (event.payload.status === "error") setError("The model could not complete that response.");
        break;
      case "settings.snapshot":
      case "settings.updated":
        setSettings(event.payload.settings);
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
              <Message key={message.id} message={message} />
            ))}
          </div>

          <div className="composer-wrap">
            {settingsOpen && settings && (
              <SettingsPopover
                settings={settings}
                disabled={running}
                theme={theme}
                onThemeChange={setTheme}
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
                <span>{settings ? selectedModelName(settings) : connected ? `${agentMode === "fake" ? "Demo" : "Pi"} ready` : "Connecting…"}</span>
                <CaretDown weight="bold" />
              </button>
              <span>{window.eva?.platform === "darwin" ? "⌘⇧Space" : "Ctrl+Shift+Space"} to hide</span>
            </div>
          </div>
      </main>
    </div>
  );
}

function SettingsPopover({
  settings,
  disabled,
  theme,
  onThemeChange,
  onClose,
  onApply,
}: {
  settings: AgentSettings;
  disabled: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onClose: () => void;
  onApply: (settings: AgentSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
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
    <div className="settings-popover" ref={panelRef} role="dialog" aria-label="Model settings">
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

      <div className="settings-footer">
        <span>Applies to the next message</span>
        <button type="button" onClick={() => onApply(draft)} disabled={!changed || disabled}>Apply</button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>Ask Anything</h2>
      <p>Your local Pi assistant, one shortcut away.</p>
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
