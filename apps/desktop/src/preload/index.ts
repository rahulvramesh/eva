import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("eva", {
  getConnection: () => ipcRenderer.invoke("eva:connection"),
  getDeviceInfo: () => ipcRenderer.invoke("eva:device-info"),
  getCloudConfiguration: () => ipcRenderer.invoke("eva:cloud-config:get"),
  saveCloudConfiguration: (endpoint: string, token: string) => ipcRenderer.invoke("eva:cloud-config:set", { endpoint, token }),
  windowAction: (action: "minimize" | "maximize" | "close") => ipcRenderer.send("eva:window", action),
  setTheme: (theme: "light" | "dark") => ipcRenderer.send("eva:theme", theme),
  notify: (title: string, body: string) => ipcRenderer.send("eva:notify", { title, body }),
  onNewChat: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("eva:new-chat", handler);
    return () => ipcRenderer.removeListener("eva:new-chat", handler);
  },
  onServerError: (listener: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on("eva:server-error", handler);
    return () => ipcRenderer.removeListener("eva:server-error", handler);
  },
  platform: process.platform,
});
