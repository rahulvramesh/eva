import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ConnectionInfo = { url: string; token: string };
type WindowState = { width: number; height: number; x?: number; y?: number };

let mainWindow: BrowserWindow | null = null;
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
  mainWindow.on("close", saveWindowState);
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

function createTray(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "trayTemplate.png")
    : join(app.getAppPath(), "build/trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.warn(`Could not load Eva tray icon at ${iconPath}`);
    return;
  }
  icon.setTemplateImage(process.platform === "darwin");
  tray = new Tray(icon);
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
