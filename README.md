# Eva

Eva is a lightweight, local-first personal assistant built as a compact Electron window with a separate Pi-powered agent server.

## Use the app

- Open `release/mac-arm64/Eva.app` after running `pnpm package`, or install the Windows `.exe` produced by `pnpm package:windows`.
- Press `Command + Shift + Space` on macOS or `Control + Shift + Space` on Windows to hide or show Eva from anywhere.
- Use the Eva menu-bar icon to show or hide the window, start a new chat, toggle Always on Top, or quit.
- Eva stays above normal windows and follows you across macOS workspaces.
- On macOS, Eva uses native under-window vibrancy with a translucent charcoal or light material; Windows uses an acrylic material fallback.
- Use the sidebar button to open persisted chats, or the plus button to start a new chat.
- Use the model name below the composer to choose any configured Pi model, set capability-aware reasoning effort, and add persistent system instructions.
- Switch between persisted Light and Dark appearances from Assistant Settings.
- Eva can run shell commands in its private workspace and fetch readable content from public web pages. Windows uses Git Bash when installed and otherwise falls back to PowerShell.

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
pnpm package:windows      # Windows x64 NSIS installer
pnpm package:windows:dir  # unpacked Windows x64 app
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

The renderer has no Node.js access. The agent server binds only to `127.0.0.1`, requires a random per-launch token, validates origins, and owns all model/session state. Model settings are discovered from Pi at runtime and stored locally. Shell commands execute inside Eva's workspace, while `web_fetch` accepts only public HTTP(S) destinations, validates redirects, rejects local/private network addresses, and bounds response size and time. Shell access is powerful and can still modify files outside the workspace when explicitly instructed, so review requests that ask Eva to run commands.
