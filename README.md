# Eva

Eva is a lightweight personal assistant built as a compact Electron window. It can run locally with the Pi coding-agent SDK or connect from Electron and the browser to Eva Cloud on Cloudflare.

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
- Tool calls appear as compact expandable transcript rows with input, output, and status. Use **Assistant Settings → Tool Call Details** to show or hide them; the preference persists locally.

Eva uses the current `@earendil-works/pi-coding-agent` SDK and the Pi credentials already configured on the machine. If Pi is not configured, run `pi` in a terminal and use `/login` first.

## Eva Cloud

Eva Cloud adds access from any browser or Eva desktop installation while keeping the local Pi mode available:

- a Cloudflare Worker serves the React app and authenticated API;
- one hibernating Durable Object coordinates each user's realtime WebSocket session;
- D1 stores chats, messages, settings, tool approvals, memories, and audit events;
- Workers AI runs Kimi K2.6 and creates memory embeddings;
- Vectorize retrieves relevant long-term memories for each prompt;
- Bash runs only after explicit approval in an isolated Sandbox container;
- each user gets a credential-less, prefix-scoped R2 mount at `/workspace/data` so cloud Bash files survive container sleep;
- `web_fetch` accepts public HTTP(S) text/JSON/XML, revalidates redirects, blocks local/private targets, and bounds time and response size.

The hosted backend uses Cloudflare Workers AI. Local mode continues to use the Pi coding-agent SDK and your machine's Pi credentials. A cloud session cannot execute Bash on an offline laptop; it executes Linux Bash in the isolated cloud workspace. Select **Assistant Settings → Runtime → Eva Cloud** and enter the deployed endpoint and private token once. The token remains in that browser or Electron profile.

### Deploy

Cloud resources are declared in `wrangler.jsonc`; the initial D1 schema is in `migrations/d1/0001_initial.sql`.

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Set a long random EVA_API_TOKEN in .dev.vars for local development.

pnpm cloud:types
pnpm cloud:migrate:local
pnpm cloud:dev
EVA_CLOUD_TOKEN=your-local-token pnpm cloud:e2e

# One-time production resources (names used by wrangler.jsonc):
pnpm exec wrangler d1 create eva-cloud-production
pnpm exec wrangler r2 bucket create eva-workspaces-production
pnpm exec wrangler vectorize create eva-memory-production --preset @cf/baai/bge-base-en-v1.5
pnpm exec wrangler queues create eva-memory-production

pnpm exec wrangler secret put EVA_API_TOKEN
pnpm cloud:migrate
pnpm cloud:deploy
```

For Cloudflare Access, add both secrets and put an Access policy in front of the Worker. Token authentication remains useful for Electron and recovery:

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN  # example: your-team.cloudflareaccess.com
pnpm exec wrangler secret put ACCESS_AUD
```

Never commit `.dev.vars` or `.eva-cloud-token`. Rotate the owner token with `wrangler secret put EVA_API_TOKEN`. Every Bash invocation is pending until the user approves or rejects it in the transcript.

### Expected cost

Eva Cloud requires the Workers Paid plan because Sandbox/Containers and Vectorize are used. For a single person with intermittent use, the practical baseline is about **$5/month plus Workers AI tokens**; normal D1, Vectorize, Durable Object, and short-lived Sandbox usage should usually remain inside the plan's included allocations. Kimi K2.6 is billed at **$0.95/M input tokens, $0.16/M cached input tokens, and $4.00/M output tokens**. The `basic` Sandbox scales to zero after ten minutes; Cloudflare includes 25 GiB-hours of container memory, 375 vCPU-minutes, and 200 GB-hours of disk each month before usage charges. Set a Cloudflare account budget alert before wider use. Current prices: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/), and [Containers](https://developers.cloudflare.com/containers/pricing/).

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

Browser / Electron ── authenticated WebSocket ── Worker ── per-user Durable Object
                                                    ├── D1 chats + settings
                                                    ├── Workers AI + Vectorize memory
                                                    └── approved Bash ── Sandbox ── R2
```

- `apps/desktop`: Electron main/preload and React renderer.
- `apps/agent-server`: loopback WebSocket server, chat persistence, and Pi adapter.
- `apps/cloud`: Cloudflare Worker, Durable Object agent, authentication, memory, and cloud tools.
- `migrations/d1`: production D1 schema migrations.
- `packages/protocol`: validated shared protocol types.

The renderer has no Node.js access. The agent server binds only to `127.0.0.1`, requires a random per-launch token, validates origins, and owns all model/session state. Model settings are discovered from Pi at runtime and stored locally. Shell commands execute inside Eva's workspace, while `web_fetch` accepts only public HTTP(S) destinations, validates redirects, rejects local/private network addresses, and bounds response size and time. Shell access is powerful and can still modify files outside the workspace when explicitly instructed, so review requests that ask Eva to run commands.
