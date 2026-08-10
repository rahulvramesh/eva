export {};

declare global {
  interface Window {
    eva?: {
      getConnection(): Promise<{ url: string; token: string }>;
      windowAction(action: "minimize" | "maximize" | "close"): void;
      setTheme(theme: "light" | "dark"): void;
      onServerError(listener: (message: string) => void): () => void;
      platform: string;
    };
  }
}
