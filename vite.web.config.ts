import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("apps/desktop/src/renderer"),
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
