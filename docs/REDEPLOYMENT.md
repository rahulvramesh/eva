# Eva reproducible deployment runbook

This runbook recreates Eva Cloud under another Cloudflare account or restores it after a teardown. It intentionally contains no credentials or secret values.

## Prerequisites

- Node.js 22 or newer and pnpm 11.
- A Cloudflare account on Workers Paid with Workers AI, D1, R2, Vectorize, Queues, Durable Objects, Containers/Sandbox, and Email Sending access.
- Wrangler 4.x authenticated with `pnpm exec wrangler login`.
- A Cloudflare DNS domain onboarded to Email Sending.
- Docker available when Wrangler needs to build the Sandbox container.

Verify the local toolchain and account:

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler --version
pnpm exec wrangler whoami
pnpm exec wrangler email sending list
```

## 1. Choose deployment names

The checked-in production configuration uses:

- Worker: `eva-cloud`
- D1: `eva-cloud-production`
- R2: `eva-workspaces-production`
- Vectorize: `eva-memory-production`
- Queue: `eva-memory-production`
- email domain: `notify.tarx.app`
- email sender: `reminders@notify.tarx.app`

For a new account, either create resources with these names or update every corresponding entry in `wrangler.jsonc`. Replace the D1 `database_id` with the ID returned when the new database is created. Resource IDs are deployment-specific and are the only non-secret account identifiers currently checked into the configuration.

## 2. Provision resources

```bash
pnpm exec wrangler d1 create eva-cloud-production
pnpm exec wrangler r2 bucket create eva-workspaces-production
pnpm exec wrangler vectorize create eva-memory-production --preset @cf/baai/bge-base-en-v1.5
pnpm exec wrangler queues create eva-memory-production
```

Durable Object namespaces and the Sandbox container are created or migrated by `wrangler deploy` from `wrangler.jsonc`. Do not collapse or reorder the Durable Object migration tags; `v1` creates `EvaAgent` and `Sandbox`, while `v2` adds `ReminderScheduler`.

Onboard the sending domain if it is not already listed:

```bash
pnpm exec wrangler email sending enable notify.tarx.app
pnpm exec wrangler email sending list
```

Cloudflare adds the required bounce MX, SPF, DKIM and DMARC records during onboarding. If a different domain is used, change both `EVA_REMINDER_FROM` and `allowed_sender_addresses` in `wrangler.jsonc`.

## 3. Configure secrets

Generate a long random owner token locally. Never place the value in shell history, source files, this document, or a command argument. Enter it through Wrangler's interactive prompt:

```bash
pnpm exec wrangler secret put EVA_API_TOKEN
```

Optional Cloudflare Access authentication:

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put ACCESS_AUD
```

For local development only:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` locally and keep it uncommitted. Electron stores the deployed endpoint and owner token through Keychain-backed safe storage on macOS or DPAPI on Windows.

## 4. Generate types and validate locally

```bash
pnpm cloud:types
pnpm cloud:migrate:local
pnpm check
```

Start the local Worker in one terminal:

```bash
pnpm cloud:dev
```

Run the authenticated cloud test in another terminal. Prefer a token file to avoid shell history:

```bash
EVA_CLOUD_TOKEN_FILE=/absolute/path/to/local-token-file pnpm cloud:e2e
```

Local email bindings are simulated; they do not send real email.

## 5. Back up and migrate production D1

Before applying migrations to an existing deployment:

```bash
mkdir -p backups
pnpm exec wrangler d1 export eva-cloud-production --remote --output backups/eva-cloud-before-migration.sql
pnpm exec wrangler d1 migrations list eva-cloud-production --remote
pnpm cloud:migrate
pnpm exec wrangler d1 migrations list eva-cloud-production --remote
```

Do not commit database exports; they can contain chats, memories, email addresses and notification content.

For a completely new database, `pnpm cloud:migrate` applies `0001_initial.sql`, `0002_hybrid_provenance.sql`, `0003_reminders.sql`, and `0004_notification_timezone.sql` in order.

## 6. Deploy and verify

```bash
pnpm cloud:deploy:dry
pnpm cloud:deploy
curl --fail --silent https://YOUR-WORKER.workers.dev/api/health
EVA_CLOUD_URL=https://YOUR-WORKER.workers.dev \
  EVA_CLOUD_TOKEN_FILE=/absolute/path/to/production-token-file \
  EVA_E2E_SKIP_BASH=1 \
  pnpm cloud:e2e
```

Then perform the manual email acceptance described in `docs/REMINDERS.md`. The automated E2E test never sends email.

Record the deployed git SHA and Worker version:

```bash
git rev-parse HEAD
pnpm exec wrangler versions list
```

## 7. Build desktop clients

```bash
pnpm package              # unpacked unsigned macOS app
pnpm package:signed       # signed macOS build when signing credentials exist
pnpm package:windows      # Windows x64 NSIS installer
```

Connect each desktop installation to the deployed Worker endpoint and owner token. Verify the global shortcut, tray menu, a cloud chat, a local file task, and a native reminder notification.

## Restore and rollback

Worker rollback does not reverse D1 migrations:

```bash
pnpm exec wrangler versions list
pnpm exec wrangler rollback VERSION_ID
```

The reminder migration is additive, so rolling back the Worker leaves unused reminder tables but does not damage chat data. For a full disaster recovery, create a fresh D1 database, import the protected SQL export, update `database_id`, redeploy, and run authenticated acceptance tests before switching users to the new endpoint.

R2 workspace objects and Vectorize embeddings are separate from D1. Back up R2 independently when workspace recovery matters. Vectorize can be rebuilt from active D1 memories by re-enqueuing them; D1 remains the canonical memory store.

## Security checklist

- No `.dev.vars`, token files, D1 exports or application-support data are committed.
- The email binding restricts sender addresses.
- Reminder recipients are user-configured and are never accepted from a model tool.
- Bash still requires approval; reminders do not bypass it.
- `wrangler whoami`, health, authenticated WebSocket, D1 migrations and the reminder alarm are verified after deployment.
