# Eva

Eva is a lightweight, local-first personal assistant built as a compact Electron window with a separate Pi-powered agent server.

## Use the app

- Open `release/mac-arm64/Eva.app` after running `pnpm package`.
- Press `Command + Shift + Space` on macOS to hide or show Eva from anywhere.
- Eva stays above normal windows and follows you across macOS workspaces.
- On macOS, Eva uses native under-window vibrancy with a translucent charcoal or light material; Windows uses an acrylic material fallback.
- Use the sidebar button to open persisted chats, or the plus button to start a new chat.
- Use the model name below the composer to choose any configured Pi model, set capability-aware reasoning effort, and add persistent system instructions.
- Switch between persisted Light and Dark appearances from Assistant Settings.

Eva uses the current `@earendil-works/pi-coding-agent` SDK and the Pi credentials already configured on the machine. If Pi is not configured, run `pi` in a terminal and use `/login` first.

## Development

```bash
pnpm install
pnpm dev          # real Pi backend
pnpm dev:fake     # deterministic Electron demo
pnpm dev:browser  # deterministic browser design preview
pnpm check        # typecheck, tests, and production build
pnpm package      # unsigned local macOS app
pnpm package:signed
```

## Architecture

```text
Electron renderer ── authenticated WebSocket ── local agent server ── Pi SDK
        │                                             │
        └── window UI only                            └── sessions + streaming

Electron main ── supervises local server + owns window/global shortcut
```

- `apps/desktop`: Electron main/preload and React renderer.
- `apps/agent-server`: loopback WebSocket server, chat persistence, and Pi adapter.
- `packages/protocol`: validated shared protocol types.

The renderer has no Node.js access. The agent server binds only to `127.0.0.1`, requires a random per-launch token, validates origins, and owns all model/session state. Model settings are discovered from Pi at runtime and stored locally. Pi tools are disabled in this first version; the app is a safe chat assistant rather than an unrestricted shell agent.
