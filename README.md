# HomePilot

A personal operations assistant for one household: tasks, reminders, calendar-aware nudges, a
safety layer for anything that touches the outside world, and honest cost tracking for the
models it uses. It is designed to sit **next to** an existing OpenClaw install on a Mac mini,
not inside it and not instead of it.

This repository is the **Phase 1 MVP**. It runs end to end in dry-run mode with no API keys.

## Read this first: what is real, what is mocked, what is blocked

| Area | Status | Notes |
| --- | --- | --- |
| Tasks, reminders, snooze, done, dismiss | **Implemented** | SQLite, survives restarts |
| Durable scheduler | **Implemented** | Leases, retries, backoff, recovery after a crash, fake-clock tests |
| Nudge engine | **Implemented** | Deterministic rules: quiet hours, daily cap, cooldowns, calendar fit |
| Plain-text commands | **Implemented** | Deterministic parser first, small model only as a fallback |
| Policy and approvals | **Implemented** | Tiers A/B/C, default-deny scopes, hash-bound single-use approvals, kill switch |
| Usage and cost tracking | **Implemented** | Per call, per feature, budget alerts, hypothetical Claude-only comparison |
| Local dashboard and CLI | **Implemented** | Loopback only, token protected |
| Notifications | **Dry-run by default** | Local outbox. With iMessage enabled and dry-run off, texted to you |
| Model calls | **Mocked by default** | OpenRouter adapter, off until you set `HOMEPILOT_MODEL_PROVIDER=openrouter`. First live calls made on the Mac mini on 2026-11-17 |
| Google Calendar | **Mocked** | In-memory mock only. Real adapter is **not implemented** |
| Calendar events, cart, orders, outside messages | **Mocked** | Tools exist so the approval flow can be exercised. They have no real effect |
| iMessage | **Working on the Mac mini** | HomePilot reads your texts and replies through the `imsg` tool, and texts reminders. Off by default; see [operations](docs/operations.md#imessage-setup) |
| H-E-B, Amazon, Marketplace, travel, bookings | **Not implemented** | Phase 3 and 4 |
| OpenClaw audit (Phase 0) | **Done** | Read-only audit run on the Mac; the report stays out of Git |
| OpenClaw skill | **Prepared, not used** | `src/integrations/openclaw/skill/`. HomePilot handles iMessage itself |
| launchd service | **Prepared, not installed** | Template only, not verified on macOS |
| Keychain lookup | **Written, not verified** | Never run on a real Mac |

Everything in this repository was built and tested in a Linux cloud sandbox. **Nothing here has
run on the Mac mini, and nothing has touched OpenClaw.** Statements about OpenClaw in the docs
come from docs.openclaw.ai as read on 2026-11-16 and are labelled unverified.

## Quick start

Needs Node.js 22.13 or newer. No native build step, no API key.

```bash
npm install
npm run check      # typecheck + 130 tests
npm run demo       # 13-step dry-run walkthrough on a throwaway database
```

To use it for real (still dry-run, still no key):

```bash
cp .env.example .env
npm run build
./bin/homepilot init
./bin/homepilot say "remind me to call the dentist tomorrow at 10am"
./bin/homepilot say "I need a haircut sometime this week"
./bin/homepilot task list
./bin/homepilot run            # the scheduler loop; Ctrl+C to stop
```

In another terminal, `./bin/homepilot outbox` shows what would have been sent.

## Commands

`./bin/homepilot help` prints the full list. The ones you will use most:

| Command | What it does |
| --- | --- |
| `say "<text>"` | Send a message exactly as a text would arrive |
| `task add / list / done / dismiss / snooze` | Direct task management |
| `run [--interval N]` | Scheduler loop (what launchd will run) |
| `tick` | Run everything that is due now, once |
| `nudges` | Show what the nudge engine would do right now and why. Sends nothing |
| `outbox` | Notifications (recorded, not sent, in dry-run) |
| `pause` / `resume` | Kill switch for all notifications and actions |
| `approvals`, `permissions`, `events` | Safety state and audit trail |
| `health`, `usage`, `usage export` | Status, cost report, raw export (CSV or JSON) |
| `models sync` | Refresh model prices from OpenRouter's public catalog (no key needed) |
| `serve` | Local dashboard at `http://127.0.0.1:8787` |
| `backup [DIR]` | Consistent copy of the database |

Things you can say: "remind me to X tomorrow at 10am", "I need to X before Friday", "tasks",
"done with X", "snooze that until tomorrow 8am", "dismiss X", "stop reminding me about X", "what should I do with my free
hour?", "pause", "resume", "usage", "approve CODE", "deny CODE".

Most messages are understood by plain code and never reach a model. When one does, the reply
ends with `(read by <model>)`, naming the model that actually answered (a fallback, if the first
choice failed). Turn that off with `HOMEPILOT_REPLY_SHOWS_MODEL=false`.

## Credentials: what is needed and where each one goes

**To run the tests, the demo and dry-run mode you need no credentials at all.**

Never paste a key into a chat, a ticket or a commit. `.env` is git-ignored. On the Mac, the
Keychain is preferred over `.env`.

| Credential | Needed for | Where to get it | Where to put it |
| --- | --- | --- | --- |
| **OpenRouter API key** | Real model calls (only when `HOMEPILOT_MODEL_PROVIDER=openrouter`) | https://openrouter.ai/keys. Create a key, and set a credit limit on it there | Keychain (below), or `OPENROUTER_API_KEY=` in `.env` |
| **Dashboard token** | `homepilot serve` | You generate it: `openssl rand -hex 32` | `HOMEPILOT_API_TOKEN=` in `.env`, or Keychain |
| **Google OAuth client** (Phase 2, not used yet) | Reading your calendar | Google Cloud Console: create a project, enable the Google Calendar API, create an OAuth client of type "Desktop app" | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` placeholders in `.env.example`. The adapter is not written yet, so do not create this until Phase 2 |
| **Your iMessage handle** | Allowlisting the one sender who may command HomePilot | Your own phone number or Apple ID email | `HOMEPILOT_ALLOWED_SENDERS` in `.env`. Not a secret, but it is personal, so keep it out of Git |

Storing a secret in the macOS Keychain (the command prompts for the value, so it never lands
in your shell history):

```bash
security add-generic-password -U -s homepilot -a OPENROUTER_API_KEY -w
security add-generic-password -U -s homepilot -a HOMEPILOT_API_TOKEN -w
```

HomePilot looks in the environment first, then in the Keychain under service `homepilot`.

Two things worth knowing before you buy credit:

- A Claude Pro or Max subscription is **not** OpenRouter credit and cannot be used here.
  OpenRouter is billed separately, per token.
- OpenClaw has its own OpenRouter setup (`openclaw onboard --auth-choice openrouter-api-key`
  according to its docs). HomePilot does not read or change it. Use a **separate** key for
  HomePilot so spend can be attributed and capped independently.

## Going live

Dry-run is the default and stays on until you turn it off. The order that keeps risk low is in
[docs/roadmap.md](docs/roadmap.md); the short version:

1. Run `bash scripts/audit-openclaw.sh` on the Mac mini (read-only) and review the report.
2. Add the OpenRouter key, set `HOMEPILOT_MODEL_PROVIDER=openrouter`, keep `HOMEPILOT_DRY_RUN=true`.
3. Set up iMessage, listen-only first, then live ([docs/operations.md](docs/operations.md#imessage-setup)).
4. Install the launchd service ([docs/operations.md](docs/operations.md)).
5. Phase 2: Google Calendar read-only.

## Documentation

- [docs/architecture.md](docs/architecture.md): design, diagram, delivery guarantees, risks and assumptions
- [docs/integration-matrix.md](docs/integration-matrix.md): what to reuse from OpenClaw and what HomePilot builds, with verification status
- [docs/security-model.md](docs/security-model.md): tiers, approvals, prompt injection, known gaps
- [docs/cost-methodology.md](docs/cost-methodology.md): how costs and the Claude-only comparison are calculated
- [docs/operations.md](docs/operations.md): install, launchd, backup, restore, uninstall
- [docs/roadmap.md](docs/roadmap.md): phases, acceptance tests, what is blocked on what

## Layout

```
src/
  app.ts                 composition root: wires everything, owns the message handler
  cli.ts                 command-line interface
  config.ts, secrets.ts  validated configuration; env then Keychain
  clock.ts, time.ts      injectable clock; time-zone maths and the date parser
  db/                    SQLite wrapper and migrations
  domain/                tasks, reminders, preferences, approvals, audit events
  scheduler/             durable job queue
  notify/                outbox and channels (dry-run channel only)
  nudges/                deterministic nudge engine
  intent/                command parser and the model fallback contract
  models/                router, OpenRouter adapter, mock provider, price book
  telemetry/             usage recording, reports, export
  tools/                 policy engine, executor, built-in tools
  api/                   loopback HTTP API and dashboard
  integrations/          google-calendar (mock), openclaw (skill draft), imessage (imsg)
scripts/                 demo, read-only OpenClaw audit, launchd template
tests/                   130 tests, all offline
```

## Tests

```bash
npm run check
```

All tests are offline and use a fake clock. The Phase 1 acceptance test is
`tests/acceptance.test.ts`: a task is saved to a file database, the database is closed and
reopened, the reminder fires exactly once at its due time, the outcome is recorded, and the run
is logged as deterministic (no model used).
