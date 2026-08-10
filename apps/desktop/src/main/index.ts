import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification as ElectronNotification, safeStorage, shell, Tray } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

type ConnectionInfo = { url: string; token: string };
type WindowState = { width: number; height: number; x?: number; y?: number };
type CloudConfiguration = { endpoint: string; token: string };

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let agentProcess: ChildProcess | null = null;
let connection: ConnectionInfo | null = null;
let tray: Tray | null = null;
let restartCount = 0;
let quitting = false;

app.setName("Eva");

app.whenReady().then(async () => {
  registerIpc();
  connection = await startAgentServer();
  createWindow();
  createTray();
  registerGlobalShortcut();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && connection) createWindow();
});

app.on("before-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  agentProcess?.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function createWindow(): void {
  const saved = loadWindowState();
  const macVisualEffect = process.platform === "darwin"
    ? { vibrancy: "under-window" as const, visualEffectState: "active" as const }
    : {};
  mainWindow = new BrowserWindow({
    ...saved,
    ...macVisualEffect,
    minWidth: 420,
    minHeight: 560,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    roundedCorners: true,
    alwaysOnTop: true,
    title: "Eva",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (process.platform === "win32") mainWindow.setBackgroundMaterial("acrylic");
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on("close", (event) => {
    saveWindowState();
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function showSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    parent: mainWindow ?? undefined,
    width: 760,
    height: 720,
    minWidth: 600,
    minHeight: 560,
    show: false,
    title: "Eva Settings",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111312" : "#f2f5f1",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => { settingsWindow = null; });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set("view", "settings");
    void settingsWindow.loadURL(url.toString());
  } else {
    void settingsWindow.loadFile(join(__dirname, "../renderer/index.html"), { query: { view: "settings" } });
  }
}

function createTray(): void {
  const iconName = process.platform === "darwin" ? "trayTemplate.png" : "icon.png";
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(app.getAppPath(), "build", iconName);
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.warn(`Could not load Eva tray icon at ${iconPath}`);
    return;
  }
  icon.setTemplateImage(process.platform === "darwin");
  tray = new Tray(process.platform === "darwin" ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Eva");
  tray.on("click", toggleWindow);
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const visible = Boolean(mainWindow?.isVisible());
  const alwaysOnTop = Boolean(mainWindow?.isAlwaysOnTop());
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? "Hide Eva" : "Show Eva",
      click: toggleWindow,
    },
    {
      label: "New Chat",
      accelerator: "CommandOrControl+N",
      click: () => {
        showWindow();
        mainWindow?.webContents.send("eva:new-chat");
      },
    },
    {
      label: "Settings…",
      accelerator: "CommandOrControl+,",
      click: showSettingsWindow,
    },
    { type: "separator" },
    {
      label: "Always on Top",
      type: "checkbox",
      checked: alwaysOnTop,
      click: (item) => {
        mainWindow?.setAlwaysOnTop(item.checked, item.checked ? "floating" : "normal");
        updateTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "Quit Eva",
      role: "quit",
    },
  ]));
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (connection) createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showWindow();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

function registerGlobalShortcut(): void {
  const registered = globalShortcut.register("CommandOrControl+Shift+Space", () => {
    toggleWindow();
  });
  if (!registered) console.warn("Could not register the Eva global shortcut");
}

function registerIpc(): void {
  ipcMain.handle("eva:connection", (event) => {
    validateSender(event.senderFrame?.url ?? "");
    if (!connection) throw new Error("Agent server is not ready");
    return connection;
  });
  ipcMain.handle("eva:device-info", (event) => {
    validateSender(event.senderFrame?.url ?? "");
    return loadDeviceInfo();
  });
  ipcMain.handle("eva:cloud-config:get", (event) => {
    validateSender(event.senderFrame?.url ?? "");
    return loadCloudConfiguration();
  });
  ipcMain.handle("eva:cloud-config:set", (event, value: CloudConfiguration) => {
    validateSender(event.senderFrame?.url ?? "");
    saveCloudConfiguration(value);
  });
  ipcMain.on("eva:window", (event, action: string) => {
    validateSender(event.senderFrame?.url ?? "");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (action === "minimize") window.minimize();
    if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === "close") window.close();
  });
  ipcMain.on("eva:theme", (event, theme: string) => {
    validateSender(event.senderFrame?.url ?? "");
    if (theme !== "light" && theme !== "dark") return;
    nativeTheme.themeSource = theme;
  });
  ipcMain.on("eva:settings:open", (event) => {
    validateSender(event.senderFrame?.url ?? "");
    showSettingsWindow();
  });
  ipcMain.on("eva:notify", (event, value: { title?: unknown; body?: unknown }) => {
    validateSender(event.senderFrame?.url ?? "");
    if (typeof value?.title !== "string" || typeof value?.body !== "string") return;
    const title = value.title.trim().slice(0, 200);
    const body = value.body.trim().slice(0, 1_000);
    if (!title || !ElectronNotification.isSupported()) return;
    const notification = new ElectronNotification({ title, body, silent: false });
    notification.on("click", showWindow);
    notification.show();
  });
}

function validateSender(url: string): void {
  const validDev = Boolean(process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL));
  if (!url.startsWith("file:") && !validDev) throw new Error("Untrusted renderer");
}

async function startAgentServer(): Promise<ConnectionInfo> {
  const port = await findFreePort();
  const token = randomBytes(32).toString("hex");
  const serverEntry = join(app.getAppPath(), "dist/server/index.js");
  if (!existsSync(serverEntry)) throw new Error(`Agent server bundle not found at ${serverEntry}`);

  const launch = (): Promise<void> => new Promise((resolve, reject) => {
    const child = fork(serverEntry, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        EVA_PORT: String(port),
        EVA_TOKEN: token,
        EVA_DATA_DIR: app.getPath("userData"),
        EVA_WORKSPACE: join(app.getPath("userData"), "workspace"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    agentProcess = child;
    const timer = setTimeout(() => reject(new Error("Agent server did not become ready")), 15_000);
    child.stdout?.on("data", (chunk) => process.stdout.write(`[agent] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
    child.once("message", (message) => {
      if (typeof message === "object" && message && "type" in message && message.type === "ready") {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      agentProcess = null;
      if (!quitting && restartCount < 1) {
        restartCount += 1;
        setTimeout(() => void launch().catch(showFatalServerError), 500);
      } else if (!quitting) {
        showFatalServerError(new Error("The agent server stopped unexpectedly."));
      }
    });
  });

  await launch();
  return { url: `ws://127.0.0.1:${port}/ws`, token };
}

function showFatalServerError(error: unknown): void {
  mainWindow?.webContents.send("eva:server-error", error instanceof Error ? error.message : "Agent server failed");
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a local port"));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function statePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadDeviceInfo(): { id: string; name: string; platform: string; workspace: string } {
  const path = join(app.getPath("userData"), "device.json");
  let id: string | undefined;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { id?: string };
    if (typeof saved.id === "string" && saved.id.length >= 16) id = saved.id;
  } catch {
    // A device identity is created on first launch.
  }
  if (!id) {
    id = randomBytes(24).toString("hex");
    writeFileSync(path, JSON.stringify({ id }), { mode: 0o600 });
  }
  return {
    id,
    name: hostname() || (process.platform === "win32" ? "Windows PC" : "Mac"),
    platform: process.platform,
    workspace: join(app.getPath("userData"), "workspace"),
  };
}

function cloudConfigurationPath(): string {
  return join(app.getPath("userData"), "cloud-configuration.json");
}

function loadCloudConfiguration(): CloudConfiguration | undefined {
  try {
    const saved = JSON.parse(readFileSync(cloudConfigurationPath(), "utf8")) as { endpoint?: string; encryptedToken?: string };
    if (!saved.endpoint || !saved.encryptedToken || !safeStorage.isEncryptionAvailable()) return undefined;
    return {
      endpoint: saved.endpoint,
      token: safeStorage.decryptString(Buffer.from(saved.encryptedToken, "base64")),
    };
  } catch {
    return undefined;
  }
}

function saveCloudConfiguration(value: CloudConfiguration): void {
  const endpoint = typeof value?.endpoint === "string" ? value.endpoint.trim().replace(/\/$/, "") : "";
  const token = typeof value?.token === "string" ? value.token.trim() : "";
  if (!endpoint || !token) throw new Error("Cloud endpoint and token are required.");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this device.");
  const encryptedToken = safeStorage.encryptString(token).toString("base64");
  writeFileSync(cloudConfigurationPath(), JSON.stringify({ endpoint, encryptedToken }), { mode: 0o600 });
}

function loadWindowState(): WindowState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as WindowState;
  } catch {
    return { width: 500, height: 720 };
  }
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
  writeFileSync(statePath(), JSON.stringify(mainWindow.getBounds()), { mode: 0o600 });
}
