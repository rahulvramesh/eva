# Eva

Eva is a lightweight personal assistant built as a compact Electron window. One synced chat combines Eva Cloud with the Pi coding-agent SDK and tools on your connected computers.

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
- There is no local/cloud mode switch. **Execution → Auto** keeps ordinary answers in Cloudflare and routes file, repository, terminal, and installed-software tasks to an online Eva desktop. Cloud and This device are explicit overrides.
- **Private** requires a verified on-device Pi model such as Ollama and never silently falls back to cloud inference. Chats still sync unless the computer is offline.
- Offline chats run through Pi and enter an outbox. Responses sync after reconnect; local command output is redacted by default unless **Offline Tool Output Sync** is enabled.
- Create one-time or recurring reminders from chat or **Assistant Settings → Reminders**. Cloudflare owns the schedule, so app and email reminders continue while Eva Desktop or the computer is offline.
- Open **Task Center** from the checklist icon to create, monitor, cancel, and reopen durable background tasks. You can also ask Eva to “run this in the background.” Cloud tasks continue while your computer is off; device/private tasks wait until an Eva desktop reconnects.
- Eva can render plans, choices, comparison tables, reminders, and approval requests as persistent native cards. The model selects only validated schemas; it cannot generate executable UI code.

Eva uses the current `@earendil-works/pi-coding-agent` SDK and the Pi credentials already configured on the machine. If Pi is not configured, run `pi` in a terminal and use `/login` first.

## Eva Cloud

Eva Cloud provides the canonical synced chat and automatically discovers connected Eva desktop devices:

- a Cloudflare Worker serves the React app and authenticated API;
- one hibernating Durable Object coordinates each user's realtime WebSocket session;
- D1 stores chats, messages, settings, tool approvals, memories, and audit events;
- Workers AI runs Kimi K2.6 with true token streaming and creates memory embeddings;
- D1 provides immediate, authoritative cross-chat recall while Vectorize adds asynchronous semantic matches;
- up to three chats can stream concurrently, with per-chat stop controls across cloud and connected Pi devices;
- Vectorize retrieves relevant long-term memories for each prompt;
- Bash runs only after explicit approval in an isolated Sandbox container;
- each user gets a credential-less, prefix-scoped R2 mount at `/workspace/data` so cloud Bash files survive container sleep;
- `web_fetch` accepts public HTTP(S) text/JSON/XML, revalidates redirects, blocks local/private targets, and bounds time and response size.
- device execution uses an outbound-only authenticated WebSocket; no inbound port, router configuration, or Cloudflare Tunnel to the laptop is required;
- protocol v3 streams device model capabilities, route provenance, tool events, typed generative UI, cancellation, presence, and idempotent offline-turn imports.
- a separate per-user scheduler Durable Object wakes for reminders and queued background tasks; D1 persists schedules, task state, dedicated task chats, notification history, and delivery preferences;
- native Electron notifications and Cloudflare Email Service deliver reminders through the app and `reminders@notify.tarx.app`.

The hosted backend uses Cloudflare Workers AI. Connected desktop turns use the Pi coding-agent SDK, its configured models, and the device's Eva workspace. If no desktop is online, Auto falls back to cloud for ordinary requests and reports a clear error for an explicitly device-only task. Enter the deployed endpoint and private token once: Electron encrypts it with macOS Keychain-backed safe storage or Windows DPAPI; the browser keeps its token in that browser profile.

### Deploy

Cloud resources are declared in `wrangler.jsonc`; D1 migrations are in `migrations/d1`.

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

# Onboard or verify the transactional sending domain used by EVA_REMINDER_FROM.
pnpm exec wrangler email sending list
# If needed: pnpm exec wrangler email sending enable notify.tarx.app

pnpm exec wrangler secret put EVA_API_TOKEN
pnpm cloud:migrate
pnpm cloud:deploy
```

The complete reproducible setup, migration, validation, rollback, task recovery, and reminder email instructions are in [`docs/REDEPLOYMENT.md`](docs/REDEPLOYMENT.md). Reminder behavior and failure semantics are in [`docs/REMINDERS.md`](docs/REMINDERS.md). The typed UI contract, security boundary, lifecycle, and extension checklist are in [`docs/GENERATIVE_UI.md`](docs/GENERATIVE_UI.md).

For Cloudflare Access, add both secrets and put an Access policy in front of the Worker. Token authentication remains useful for Electron and recovery:

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN  # example: your-team.cloudflareaccess.com
pnpm exec wrangler secret put ACCESS_AUD
```

Never commit `.dev.vars` or `.eva-cloud-token`. Rotate the owner token with `wrangler secret put EVA_API_TOKEN`. Cloud Sandbox Bash is pending until the user approves or rejects it in the transcript. Device Bash starts in Eva's configured workspace but remains powerful.

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
Browser / Electron ── authenticated WebSocket ── Worker ── per-user Durable Object
          │                                         ├── D1 canonical chats + provenance
          │                                         ├── Workers AI + Vectorize memory
          │                                         └── approved cloud Bash ── Sandbox ── R2
          │
          └── Electron outbound device bridge ── loopback agent server ── Pi SDK + local tools
                       └── offline outbox ────────────────┘

Per-user Scheduler DO ── alarm ── D1 queued task ── dedicated chat ── cloud or device execution
```

- `apps/desktop`: Electron main/preload and React renderer.
- `apps/agent-server`: loopback WebSocket server, chat persistence, and Pi adapter.
- `apps/cloud`: Cloudflare Worker, Durable Object agent, authentication, memory, and cloud tools.
- `migrations/d1`: production D1 schema migrations.
- `packages/protocol`: validated shared protocol types.

The renderer has no Node.js access. The agent server binds only to `127.0.0.1`, requires a random per-launch token, validates origins, and owns all model/session state. Model settings are discovered from Pi at runtime and stored locally. Shell commands execute inside Eva's workspace, while `web_fetch` accepts only public HTTP(S) destinations, validates redirects, rejects local/private network addresses, and bounds response size and time. Shell access is powerful and can still modify files outside the workspace when explicitly instructed, so review requests that ask Eva to run commands.
