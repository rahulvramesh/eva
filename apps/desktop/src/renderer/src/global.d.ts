export {};

declare global {
  interface Window {
    eva?: {
      getConnection(): Promise<{ url: string; token: string }>;
      getDeviceInfo(): Promise<{ id: string; name: string; platform: string; workspace: string }>;
      getCloudConfiguration(): Promise<{ endpoint: string; token: string } | undefined>;
      saveCloudConfiguration(endpoint: string, token: string): Promise<void>;
      windowAction(action: "minimize" | "maximize" | "close"): void;
      setTheme(theme: "light" | "dark"): void;
      notify(title: string, body: string): void;
      onNewChat(listener: () => void): () => void;
      onServerError(listener: (message: string) => void): () => void;
      platform: string;
    };
  }
}
