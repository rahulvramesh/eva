import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("eva", {
  getConnection: () => ipcRenderer.invoke("eva:connection"),
  windowAction: (action: "minimize" | "maximize" | "close") => ipcRenderer.send("eva:window", action),
  setTheme: (theme: "light" | "dark") => ipcRenderer.send("eva:theme", theme),
  onServerError: (listener: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on("eva:server-error", handler);
    return () => ipcRenderer.removeListener("eva:server-error", handler);
  },
  platform: process.platform,
});
