import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Brain,
  CalendarBlank,
  CaretDown,
  ChatCircleDots,
  CheckCircle,
  Checks,
  Circle,
  Cloud,
  Code,
  Eye,
  EyeSlash,
  GlobeHemisphereWest,
  GearSix,
  Info,
  Moon,
  Envelope,
  Plus,
  SidebarSimple,
  Sparkle,
  Stop,
  Sun,
  TerminalWindow,
  Trash,
  WarningCircle,
  X,
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
  type EvaNotification,
  type NotificationPreferences,
  type Reminder,
  type ReminderRecurrence,
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
  const [notificationMenuOpen, setNotificationMenuOpen] = useState(false);
  const [activePage, setActivePage] = useState<"chat" | "notifications">("chat");
  const [settings, setSettings] = useState<AgentSettings>();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notifications, setNotifications] = useState<EvaNotification[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>({
    email: "",
    appEnabled: true,
    emailEnabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta",
  });
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
    const syncWindowPreference = (event: StorageEvent) => {
      if (event.key === "eva-theme" && (event.newValue === "light" || event.newValue === "dark")) setTheme(event.newValue);
      if (event.key === "eva-show-tool-calls") setShowToolCalls(event.newValue !== "false");
      if (event.key === "eva-sync-offline-tool-output") setSyncOfflineToolOutput(event.newValue === "true");
      if (event.key === "eva-routing-policy" && (event.newValue === "auto" || event.newValue === "cloud" || event.newValue === "device" || event.newValue === "private")) setRouting(event.newValue);
    };
    window.addEventListener("storage", syncWindowPreference);
    return () => window.removeEventListener("storage", syncWindowPreference);
  }, []);

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
      case "reminder.snapshot":
        setReminders(event.payload.reminders);
        break;
      case "reminder.updated":
        setReminders((current) => [event.payload.reminder, ...current.filter((reminder) => reminder.id !== event.payload.reminder.id)]);
        break;
      case "reminder.deleted":
        setReminders((current) => current.filter((reminder) => reminder.id !== event.payload.reminderId));
        break;
      case "notification.snapshot":
        setNotifications(event.payload.notifications);
        break;
      case "notification.created":
        setNotifications((current) => [event.payload.notification, ...current.filter((notification) => notification.id !== event.payload.notification.id)]);
        showNativeNotification(event.payload.notification);
        break;
      case "notification.read":
        setNotifications((current) => current.map((notification) => notification.id === event.payload.notificationId
          ? { ...notification, readAt: event.payload.readAt }
          : notification));
        break;
      case "notification.preferences":
        setNotificationPreferences(event.payload.preferences);
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
    setActivePage("chat");
    setSidebarOpen(false);
  }

  function createChat(): void {
    setActivePage("chat");
    setNotificationMenuOpen(false);
    clientRef.current?.send(command("chat.create", {}));
  }

  function markNotificationRead(notificationId: string): void {
    clientRef.current?.send(command("notification.read", { notificationId }));
  }

  function openNotifications(): void {
    setActivePage("notifications");
    setNotificationMenuOpen(false);
    setSidebarOpen(false);
    setSettingsOpen(false);
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

  function applyAgentSettings(next: AgentSettings): void {
    clientRef.current?.send(command("settings.update", {
      provider: next.selectedModel.provider,
      modelId: next.selectedModel.id,
      thinkingLevel: next.thinkingLevel,
      systemInstructions: next.systemInstructions,
    }));
    setSettings(next);
  }

  function updateReminder(reminder: Reminder): void {
    clientRef.current?.send(command("reminder.update", {
      reminderId: reminder.id,
      title: reminder.title,
      notes: reminder.notes,
      runAt: reminder.nextRunAt ?? reminder.runAt,
      timezone: reminder.timezone,
      recurrence: reminder.recurrence,
      appEnabled: reminder.appEnabled,
      emailEnabled: reminder.emailEnabled,
      status: reminder.status,
    }));
  }

  function updateNotificationPreferences(preferences: NotificationPreferences): void {
    if (preferences.appEnabled && !window.eva && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    clientRef.current?.send(command("notification.preferences.update", preferences));
  }

  function showDedicatedSettings(): void {
    setSettingsOpen(false);
    if (window.eva) window.eva.openSettings();
    else location.assign(`${location.pathname}?view=settings`);
  }

  const dedicatedSettings = new URLSearchParams(location.search).get("view") === "settings";
  if (dedicatedSettings) {
    if (authenticationRequired) return <div className="settings-window-shell"><CloudLogin onConnect={async (endpoint, token) => { await saveCloudConfiguration(endpoint, token); location.reload(); }} /></div>;
    return (
      <SettingsWindow
        settings={settings}
        connected={connected}
        disabled={runningChats.size > 0}
        theme={theme}
        onThemeChange={setTheme}
        showToolCalls={showToolCalls}
        onShowToolCallsChange={setShowToolCalls}
        syncOfflineToolOutput={syncOfflineToolOutput}
        onSyncOfflineToolOutputChange={setSyncOfflineToolOutput}
        memories={memories}
        reminders={reminders}
        notificationPreferences={notificationPreferences}
        devices={devices}
        routing={routing}
        onRoutingChange={setRouting}
        onMemoryCreate={(kind, content) => clientRef.current?.send(command("memory.create", { kind, content, importance: 5 }))}
        onMemoryUpdate={(memory) => clientRef.current?.send(command("memory.update", { memoryId: memory.id, kind: memory.kind, content: memory.content, importance: memory.importance, status: memory.status }))}
        onMemoryDelete={(memoryId) => clientRef.current?.send(command("memory.delete", { memoryId }))}
        onReminderCreate={(input) => clientRef.current?.send(command("reminder.create", input))}
        onReminderUpdate={updateReminder}
        onReminderDelete={(reminderId) => clientRef.current?.send(command("reminder.delete", { reminderId }))}
        onNotificationPreferences={updateNotificationPreferences}
        onApply={applyAgentSettings}
      />
    );
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
        <button className="chat-title-pill" onClick={activePage === "notifications" ? () => setActivePage("chat") : createChat} title={activePage === "notifications" ? "Back to chat" : "Start a new chat"}>
          {activePage === "notifications" ? "Notifications" : activeChat?.title === "New chat" ? "New Chat" : activeChat?.title ?? "New Chat"}
        </button>
        <div className="header-actions">
          <button
            className={notificationMenuOpen ? "header-icon notification-trigger active" : "header-icon notification-trigger"}
            onClick={() => {
              setNotificationMenuOpen((value) => !value);
              setSettingsOpen(false);
              setSidebarOpen(false);
            }}
            aria-label="Open notifications"
            aria-expanded={notificationMenuOpen}
          >
            <Bell weight={notifications.some((notification) => !notification.readAt) ? "fill" : "regular"} />
            {notifications.some((notification) => !notification.readAt) && <span className="notification-dot" />}
          </button>
          <button className="header-icon" onClick={createChat} aria-label="New chat"><Plus weight="bold" /></button>
          <button className="header-icon caret" onClick={() => setSidebarOpen((value) => !value)} aria-label="Show chats"><CaretDown weight="bold" /></button>
        </div>
      </header>

      {notificationMenuOpen && (
        <NotificationDropdown
          notifications={notifications}
          onRead={markNotificationRead}
          onViewAll={openNotifications}
          onClose={() => setNotificationMenuOpen(false)}
        />
      )}

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

      {activePage === "notifications" ? (
        <NotificationPage
          notifications={notifications}
          onRead={markNotificationRead}
          onBack={() => setActivePage("chat")}
        />
      ) : <main className="conversation">
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
                devices={devices}
                onOpenSettings={showDedicatedSettings}
                onClose={() => setSettingsOpen(false)}
                onApply={(next) => {
                  applyAgentSettings(next);
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
      </main>}
    </div>
  );
}

function NotificationDropdown({
  notifications,
  onRead,
  onViewAll,
  onClose,
}: {
  notifications: EvaNotification[];
  onRead: (notificationId: string) => void;
  onViewAll: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = notifications.filter((notification) => !notification.readAt);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !(target instanceof Element && target.closest(".notification-trigger"))) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div className="notification-dropdown" ref={panelRef} role="dialog" aria-label="Notifications">
      <div className="notification-dropdown-heading">
        <div><Bell weight="fill" /><span>Notifications</span></div>
        <strong>{unread.length ? `${unread.length} new` : "All caught up"}</strong>
      </div>
      <div className="notification-dropdown-list">
        {notifications.length ? notifications.slice(0, 5).map((notification) => (
          <button
            key={notification.id}
            type="button"
            className={notification.readAt ? "notification-menu-item read" : "notification-menu-item"}
            onClick={() => { if (!notification.readAt) onRead(notification.id); }}
          >
            <span className="notification-menu-icon"><CalendarBlank weight="bold" /></span>
            <span className="notification-menu-copy"><strong>{notification.title}</strong><span>{notification.body}</span><small>{relativeDate(notification.createdAt)}</small></span>
            {!notification.readAt && <span className="notification-unread-marker" aria-label="Unread" />}
          </button>
        )) : (
          <div className="notification-dropdown-empty"><CheckCircle weight="regular" /><strong>No notifications yet</strong><span>Reminder updates will appear here.</span></div>
        )}
      </div>
      <button type="button" className="notification-view-all" onClick={onViewAll}>View all notifications <ArrowRight weight="bold" /></button>
    </div>
  );
}

function NotificationPage({ notifications, onRead, onBack }: {
  notifications: EvaNotification[];
  onRead: (notificationId: string) => void;
  onBack: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const unread = notifications.filter((notification) => !notification.readAt);
  const visible = filter === "unread" ? unread : notifications;

  return (
    <main className="notification-page">
      <div className="notification-page-header">
        <button type="button" className="notification-back" onClick={onBack} aria-label="Back to chat"><ArrowLeft weight="bold" /></button>
        <div><span>Inbox</span><h1>Notifications</h1><p>Reminder activity synced across your Eva devices.</p></div>
        {unread.length > 0 && <button type="button" className="mark-all-read" onClick={() => unread.forEach((notification) => onRead(notification.id))}><Checks weight="bold" /> Mark all read</button>}
      </div>
      <div className="notification-page-toolbar">
        <div className="notification-filters" role="group" aria-label="Filter notifications">
          <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All <span>{notifications.length}</span></button>
          <button type="button" className={filter === "unread" ? "active" : ""} onClick={() => setFilter("unread")}>Unread <span>{unread.length}</span></button>
        </div>
      </div>
      <div className="notification-page-list" aria-live="polite">
        {visible.length ? visible.map((notification) => (
          <article key={notification.id} className={notification.readAt ? "notification-card read" : "notification-card"}>
            <span className="notification-card-icon"><CalendarBlank weight="bold" /></span>
            <div className="notification-card-copy">
              <div><strong>{notification.title}</strong>{!notification.readAt && <span>New</span>}</div>
              <p>{notification.body}</p>
              <small>{formatNotificationDate(notification.createdAt)}{notification.reminderId ? " · Reminder" : ""}</small>
            </div>
            {!notification.readAt && <button type="button" onClick={() => onRead(notification.id)}><CheckCircle weight="bold" /> Mark read</button>}
          </article>
        )) : (
          <div className="notification-page-empty"><CheckCircle weight="regular" /><h2>{filter === "unread" ? "You're all caught up" : "No notifications yet"}</h2><p>{filter === "unread" ? "There are no unread notifications." : "When Eva completes a reminder, it will appear here."}</p></div>
        )}
      </div>
    </main>
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

function SettingsPopover({ settings, disabled, devices, onOpenSettings, onClose, onApply }: {
  settings: AgentSettings;
  disabled: boolean;
  devices: DeviceCapability[];
  onOpenSettings: () => void;
  onClose: () => void;
  onApply: (settings: AgentSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const panelRef = useRef<HTMLDivElement>(null);
  const changed = agentSettingsChanged(draft, settings);

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
    <div className="settings-popover model-popover" ref={panelRef} role="dialog" aria-label="Model settings">
      <div className="settings-heading">
        <div><img className="eva-settings-icon" src={evaLogo} alt="" /><span>Model</span></div>
        <span>{draft.models.length} available</span>
      </div>
      <AgentModelFields draft={draft} devices={devices} onChange={setDraft} compact />
      <button type="button" className="open-settings-button" onClick={onOpenSettings}><GearSix weight="bold" /><span><strong>Open Eva Settings</strong><small>Appearance, tools, execution, reminders, and memory</small></span><ArrowRight weight="bold" /></button>
      <div className="settings-footer">
        <span>Applies to the next message</span>
        <button type="button" onClick={() => onApply(draft)} disabled={!changed || disabled}>Apply</button>
      </div>
    </div>
  );
}

function AgentModelFields({ draft, devices, onChange, compact = false }: {
  draft: AgentSettings;
  devices: DeviceCapability[];
  onChange: (settings: AgentSettings) => void;
  compact?: boolean;
}) {
  const providers = useMemo(() => {
    const grouped = new Map<string, AgentSettings["models"]>();
    for (const model of draft.models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    return [...grouped.entries()];
  }, [draft.models]);
  const selected = draft.models.find((model) => model.provider === draft.selectedModel.provider && model.id === draft.selectedModel.id);

  return <div className={compact ? "agent-model-fields compact" : "agent-model-fields"}>
    <label className="settings-field">
      <span>Model</span>
      <div className="select-wrap">
        <Brain weight="fill" />
        <select value={`${draft.selectedModel.provider}/${draft.selectedModel.id}`} onChange={(event) => {
          const model = draft.models.find((item) => `${item.provider}/${item.id}` === event.target.value);
          if (!model) return;
          onChange({ ...draft, selectedModel: { provider: model.provider, id: model.id }, thinkingLevel: model.thinkingLevels.includes(draft.thinkingLevel) ? draft.thinkingLevel : model.thinkingLevels[0] ?? "off" });
        }}>
          {providers.map(([provider, models]) => <optgroup key={provider} label={formatProvider(provider)}>{models.map((model) => <option key={`${model.provider}/${model.id}/${model.deviceId ?? "cloud"}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.executionHost === "device" ? deviceName(devices, model.deviceId) : "Cloud"}</option>)}</optgroup>)}
        </select>
        <CaretDown weight="bold" />
      </div>
      {selected?.contextWindow && <small>{formatProvider(selected.provider)} · {formatContext(selected.contextWindow)} context · {selected.executionHost === "device" ? deviceName(devices, selected.deviceId) : "Eva Cloud"}</small>}
    </label>
    <label className="settings-field">
      <span className="field-title">Reasoning Effort <Info weight="bold" aria-label="Available levels depend on the selected model" /></span>
      <div className="select-wrap effort"><Brain weight="regular" /><select value={draft.thinkingLevel} onChange={(event) => onChange({ ...draft, thinkingLevel: event.target.value as ThinkingLevel })}>{(selected?.thinkingLevels ?? ["off"]).map((level) => <option key={level} value={level}>{formatThinkingLevel(level)}</option>)}</select><CaretDown weight="bold" /></div>
    </label>
    <label className="settings-field model-instructions">
      <span>System Instructions</span>
      <textarea rows={compact ? 3 : 5} value={draft.systemInstructions} onChange={(event) => onChange({ ...draft, systemInstructions: event.target.value })} placeholder="Set Eva's tone, role, or output format." />
    </label>
  </div>;
}

type SettingsWindowProps = {
  settings?: AgentSettings;
  connected: boolean;
  disabled: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  showToolCalls: boolean;
  onShowToolCallsChange: (show: boolean) => void;
  syncOfflineToolOutput: boolean;
  onSyncOfflineToolOutputChange: (sync: boolean) => void;
  memories: Memory[];
  reminders: Reminder[];
  notificationPreferences: NotificationPreferences;
  devices: DeviceCapability[];
  routing: RoutingPolicy;
  onRoutingChange: (routing: RoutingPolicy) => void;
  onMemoryCreate: (kind: MemoryKind, content: string) => void;
  onMemoryUpdate: (memory: Memory) => void;
  onMemoryDelete: (memoryId: string) => void;
  onReminderCreate: (input: { title: string; notes: string; runAt: string; timezone: string; recurrence: ReminderRecurrence; appEnabled: boolean; emailEnabled: boolean }) => void;
  onReminderUpdate: (reminder: Reminder) => void;
  onReminderDelete: (reminderId: string) => void;
  onNotificationPreferences: (preferences: NotificationPreferences) => void;
  onApply: (settings: AgentSettings) => void;
};

function SettingsWindow(props: SettingsWindowProps) {
  const { settings, connected, disabled, theme, onThemeChange, showToolCalls, onShowToolCallsChange, syncOfflineToolOutput, onSyncOfflineToolOutputChange, memories, reminders, notificationPreferences, devices, routing, onRoutingChange, onMemoryCreate, onMemoryUpdate, onMemoryDelete, onReminderCreate, onReminderUpdate, onReminderDelete, onNotificationPreferences, onApply } = props;
  const [draft, setDraft] = useState(settings);
  useEffect(() => { if (settings) setDraft(settings); }, [settings]);
  const changed = Boolean(draft && settings && agentSettingsChanged(draft, settings));
  const close = () => window.eva ? window.eva.windowAction("close") : history.back();

  return <div className="settings-window-shell">
    <header className="settings-window-header">
      <div><img src={evaLogo} alt="" /><span><strong>Eva Settings</strong><small>{connected ? "Synced with Eva Cloud" : "Connecting…"}</small></span></div>
      <button type="button" onClick={close} aria-label="Close settings"><X weight="bold" /></button>
    </header>
    {!draft ? <div className="settings-window-loading"><Circle weight="fill" /> Loading settings…</div> : <main className="settings-window-content">
      <section className="settings-window-section">
        <div className="settings-section-heading"><span><Brain weight="fill" /> Agent</span><small>Choose Eva's model and default behavior.</small></div>
        <AgentModelFields draft={draft} devices={devices} onChange={setDraft} />
        <button type="button" className="settings-save" onClick={() => onApply(draft)} disabled={!changed || disabled}>Save agent settings</button>
      </section>

      <section className="settings-window-section">
        <div className="settings-section-heading"><span><Sun weight="fill" /> Appearance & activity</span><small>Control how Eva looks and how much execution detail is shown.</small></div>
        <div className="settings-option-grid">
          <div className="appearance-field"><span>Appearance</span><div className="theme-switch" role="group" aria-label="Appearance"><button type="button" className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")}><Sun weight="fill" /> Light</button><button type="button" className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}><Moon weight="fill" /> Dark</button></div></div>
          <div className="appearance-field"><span>Tool call details</span><div className="theme-switch" role="group" aria-label="Tool call details"><button type="button" className={showToolCalls ? "active" : ""} onClick={() => onShowToolCallsChange(true)}><Eye weight="bold" /> Show</button><button type="button" className={!showToolCalls ? "active" : ""} onClick={() => onShowToolCallsChange(false)}><EyeSlash weight="bold" /> Hide</button></div></div>
          <div className="appearance-field wide"><span>Offline tool output</span><div className="theme-switch" role="group" aria-label="Offline tool output sync"><button type="button" className={!syncOfflineToolOutput ? "active" : ""} onClick={() => onSyncOfflineToolOutputChange(false)}><EyeSlash weight="bold" /> Keep local</button><button type="button" className={syncOfflineToolOutput ? "active" : ""} onClick={() => onSyncOfflineToolOutputChange(true)}><Cloud weight="fill" /> Sync output</button></div><small>Chat responses sync after reconnect. Command output stays private by default.</small></div>
        </div>
      </section>

      <section className="settings-window-section">
        <div className="settings-section-heading"><span><TerminalWindow weight="bold" /> Execution</span><small>Choose where Eva runs tasks requiring models, files, or Bash.</small></div>
        <div className="route-grid" role="group" aria-label="Execution preference">{(["auto", "cloud", "device", "private"] as RoutingPolicy[]).map((value) => <button type="button" key={value} className={routing === value ? "active" : ""} onClick={() => onRoutingChange(value)}>{value === "auto" ? <Sparkle weight="fill" /> : value === "cloud" ? <Cloud weight="fill" /> : value === "device" ? <TerminalWindow weight="bold" /> : <EyeSlash weight="bold" />}{value === "device" ? "This device" : value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
        <p className="settings-description">{routingDescription(routing)}</p>
        <div className="device-list">{devices.length ? devices.map((device) => <div key={device.id} className={device.online ? "device online" : "device"}><Circle weight="fill" /><span>{device.name}</span><small>{device.online ? `${device.models.length} models · Bash and files ready` : "Offline"}</small></div>) : <div className="device"><Circle weight="fill" /><span>No device connected</span><small>Cloud-only tasks remain available</small></div>}</div>
      </section>

      <section className="settings-window-section"><ReminderSettings reminders={reminders} preferences={notificationPreferences} onCreate={onReminderCreate} onUpdate={onReminderUpdate} onDelete={onReminderDelete} onPreferences={onNotificationPreferences} /></section>
      <section className="settings-window-section"><MemorySettings memories={memories} onCreate={onMemoryCreate} onUpdate={onMemoryUpdate} onDelete={onMemoryDelete} /></section>
    </main>}
  </div>;
}

function MemorySettings({ memories, onCreate, onUpdate, onDelete }: { memories: Memory[]; onCreate: (kind: MemoryKind, content: string) => void; onUpdate: (memory: Memory) => void; onDelete: (memoryId: string) => void }) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryKind>("preference");
  return <div className="memory-settings dedicated-memory-settings">
    <div className="settings-section-heading"><span><Brain weight="fill" /> Online Memory <strong>{memories.filter((memory) => memory.status === "active").length}</strong></span><small>Facts and preferences available across every Eva chat.</small></div>
    <div className="memory-create"><select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} aria-label="Memory type"><option value="preference">Preference</option><option value="profile">Profile</option><option value="project">Project</option><option value="instruction">Instruction</option><option value="fact">Fact</option></select><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Something Eva should remember…" maxLength={2000} /><button type="button" disabled={!draft.trim()} onClick={() => { onCreate(kind, draft.trim()); setDraft(""); }} aria-label="Add memory"><Plus weight="bold" /></button></div>
    <div className="memory-list">{memories.length ? memories.slice(0, 50).map((memory) => <div className={`memory-item ${memory.status}`} key={memory.id}><button type="button" className="memory-content" onClick={() => onUpdate({ ...memory, status: memory.status === "active" ? "archived" : "active" })}><span>{memory.kind}</span><p>{memory.content}</p></button><button type="button" className="memory-delete" onClick={() => onDelete(memory.id)} aria-label={`Delete memory: ${memory.content}`}><Trash weight="bold" /></button></div>) : <p className="memory-empty">Eva has no long-term memories yet.</p>}</div>
  </div>;
}

function ReminderSettings({
  reminders,
  preferences,
  onCreate,
  onUpdate,
  onDelete,
  onPreferences,
}: {
  reminders: Reminder[];
  preferences: NotificationPreferences;
  onCreate: (input: { title: string; notes: string; runAt: string; timezone: string; recurrence: ReminderRecurrence; appEnabled: boolean; emailEnabled: boolean }) => void;
  onUpdate: (reminder: Reminder) => void;
  onDelete: (reminderId: string) => void;
  onPreferences: (preferences: NotificationPreferences) => void;
}) {
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta";
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [runAt, setRunAt] = useState(() => localDateTimeValue(new Date(Date.now() + 60 * 60_000)));
  const [recurrence, setRecurrence] = useState<ReminderRecurrence>("none");
  const [email, setEmail] = useState(preferences.email);
  const [appEnabled, setAppEnabled] = useState(preferences.appEnabled);
  const [emailEnabled, setEmailEnabled] = useState(preferences.emailEnabled);
  const [timezone, setTimezone] = useState(preferences.timezone);

  useEffect(() => {
    setEmail(preferences.email);
    setAppEnabled(preferences.appEnabled);
    setEmailEnabled(preferences.emailEnabled);
    setTimezone(preferences.timezone);
  }, [preferences]);

  const active = reminders.filter((reminder) => reminder.status !== "completed");
  return (
    <section className="reminder-settings">
      <div className="memory-heading"><span>Reminders</span><strong>{active.length}</strong></div>
      <div className="reminder-create">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Reminder title" maxLength={200} />
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional details" rows={2} maxLength={4000} />
        <div className="reminder-schedule-row">
          <input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
          <select value={recurrence} onChange={(event) => setRecurrence(event.target.value as ReminderRecurrence)}>
            <option value="none">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <small>{timezone} · Dates are stored as UTC instants.</small>
        <button
          type="button"
          className="reminder-add"
          disabled={!title.trim() || !runAt}
          onClick={() => {
            const timestamp = new Date(runAt);
            if (!Number.isFinite(timestamp.getTime())) return;
            onCreate({ title: title.trim(), notes: notes.trim(), runAt: timestamp.toISOString(), timezone, recurrence, appEnabled, emailEnabled });
            setTitle("");
            setNotes("");
            setRunAt(localDateTimeValue(new Date(Date.now() + 60 * 60_000)));
          }}
        ><CalendarBlank weight="bold" /> Schedule reminder</button>
      </div>

      <div className="reminder-preferences">
        <label><span><Bell weight="bold" /> App notifications</span><input type="checkbox" checked={appEnabled} onChange={(event) => setAppEnabled(event.target.checked)} /></label>
        <label><span><Envelope weight="bold" /> Email notifications</span><input type="checkbox" checked={emailEnabled} onChange={(event) => setEmailEnabled(event.target.checked)} /></label>
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        <div className="timezone-preference">
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} aria-label="Reminder timezone" placeholder="Asia/Jakarta" />
          <button type="button" onClick={() => setTimezone(detectedTimezone)}>Use current</button>
        </div>
        <button type="button" disabled={(emailEnabled && !email.trim()) || !timezone.trim()} onClick={() => onPreferences({ email: email.trim(), appEnabled, emailEnabled, timezone: timezone.trim() })}>Save delivery settings</button>
      </div>

      <div className="reminder-list">
        {active.length ? active.slice(0, 20).map((reminder) => (
          <div className={`reminder-item ${reminder.status}`} key={reminder.id}>
            <button type="button" className="reminder-main" onClick={() => onUpdate({ ...reminder, status: reminder.status === "active" ? "paused" : "active" })}>
              <strong>{reminder.title}</strong>
              <small>{reminder.status === "paused" ? "Paused" : formatReminderDate(reminder.nextRunAt ?? reminder.runAt, reminder.timezone)} · {reminder.recurrence === "none" ? "once" : reminder.recurrence}</small>
            </button>
            <button type="button" className="memory-delete" onClick={() => onDelete(reminder.id)} aria-label={`Delete reminder: ${reminder.title}`}><Trash weight="bold" /></button>
          </div>
        )) : <p className="memory-empty">No upcoming reminders.</p>}
      </div>

    </section>
  );
}

function ToolCallRow({ toolCall, onApprove, onReject }: { toolCall: ToolCall; onApprove: () => void; onReject: () => void }) {
  const preview = toolCallPreview(toolCall);
  const isWeb = toolCall.name === "web_fetch";
  const Icon = isWeb ? GlobeHemisphereWest : toolCall.name === "schedule_reminder" ? CalendarBlank : TerminalWindow;
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
          ? <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table: ({ children }) => (
                  <div className="markdown-table-scroll">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {message.content || (message.status === "streaming" ? "…" : "")}
            </ReactMarkdown>
          : <p>{message.content}</p>}
        {message.status === "aborted" && <span className="message-status">Stopped</span>}
        {message.status === "error" && <span className="message-status error">Incomplete</span>}
      </div>
    </article>
  );
}

function toolCallPreview(toolCall: ToolCall): string {
  const value = toolCall.name === "bash" ? toolCall.input.command
    : toolCall.name === "web_fetch" ? toolCall.input.url
      : toolCall.name === "schedule_reminder" ? `${String(toolCall.input.title ?? "Reminder")} · ${String(toolCall.input.run_at ?? "")}`
        : undefined;
  return typeof value === "string" ? value : JSON.stringify(toolCall.input);
}

function toolCallLabel(toolCall: ToolCall): string {
  if (toolCall.name === "bash") return "Ran command";
  if (toolCall.name === "web_fetch") return "Fetched web page";
  if (toolCall.name === "schedule_reminder") return "Scheduled reminder";
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

function formatNotificationDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function selectedModelName(settings: AgentSettings): string {
  return settings.models.find((model) => model.provider === settings.selectedModel.provider && model.id === settings.selectedModel.id)?.name ?? "Choose model";
}

function agentSettingsChanged(next: AgentSettings, current: AgentSettings): boolean {
  return JSON.stringify({ ...next, models: undefined }) !== JSON.stringify({ ...current, models: undefined });
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

function showNativeNotification(notification: EvaNotification): void {
  if (window.eva) {
    window.eva.notify(notification.title, notification.body);
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(notification.title, { body: notification.body, icon: evaLogo });
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatReminderDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}
