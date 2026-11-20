# HomePilot

[![CI](https://github.com/colebui/HomePilot/actions/workflows/ci.yml/badge.svg)](https://github.com/colebui/HomePilot/actions/workflows/ci.yml)

A local-first personal assistant you text. It keeps tasks and reminders, texts you when they
are due, nudges you about things that fit your free time, and keeps a careful record of what its
language models cost. It runs as one Node.js process with one SQLite file on a Mac mini, and you
talk to it over iMessage, the terminal, or a local dashboard.

```
you:        need to eat lunch, go to gym around 430, haircut at 6pm, grab groceries from heb at 7pm
homepilot:  Saved 4 tasks:
            1. Eat lunch.
            2. Go to gym. I'll remind you Tue Nov 17, 4:30 PM CST.
            3. Haircut. I'll remind you Tue Nov 17, 6:00 PM CST.
            4. Grab groceries from heb. I'll remind you Tue Nov 17, 7:00 PM CST.
you:        gym done, haircut done, going to grab groceries now
homepilot:  Marked "Go to gym" done. Its reminders are cancelled.
            Marked "Haircut" done. Its reminders are cancelled.
            Got it, you're on "Grab groceries from heb", so no more reminders for it. Text "done" when you finish.
```

Neither of those texts reached a model. Plain code parsed them, so they cost nothing.

## Design in one paragraph

**Deterministic code first, models last.** Dates, times, recurrence, quiet hours, cooldowns,
retries, budgets and permissions are ordinary, tested code. A model is asked only when the
parser does not recognise a message, and then it may only return a small JSON classification
that is checked against a schema. It cannot name a tool, set a date or approve anything. Every
action that touches the outside world goes through a policy layer with permission tiers and
single-use approvals bound to the exact action, and every model call is logged with its cost.

## Highlights

- **Durable scheduler.** Jobs are claimed with a compare-and-set lease, retried with backoff,
  and recovered after a crash. Notifications go through an outbox with a unique key, so a crash
  cannot lose or duplicate a reminder inside HomePilot. Time is injected everywhere, so tests
  prove "fires exactly once at 9:00" with a fake clock.
- **iMessage in and out** through the open-source [`imsg`](https://github.com/openclaw/imsg)
  tool: an allowlist of senders, one-to-one chats only, at-most-once handling of each text, a
  resume cursor after restarts, and an hourly cap against loops.
- **Safety layer.** Tiers A, B and C, default-deny permission scopes, approvals hashed over the
  tool name and its exact arguments, a kill switch, and a hard refusal for anything that came
  from third-party content (prompt injection). See [docs/security-model.md](docs/security-model.md).
- **Model routing through OpenRouter** with per-tier model lists, ordered fallbacks, timeouts,
  a concurrency limit and a monthly spend ceiling. See [Why OpenRouter](#why-openrouter) below.
- **Honest cost reporting.** Provider-reported charges, estimates, and simulated demo numbers
  are kept apart and labelled. The report also shows what share of the work never needed a model.
- **166 offline tests**, a 13-step dry-run demo, and no API key needed for either.

Stack: TypeScript, Node.js 22.13+, the built-in `node:sqlite` (no native add-ons), zod for
validation, luxon for time zones, vitest for tests. Two runtime dependencies.

## Status: what is real and what is not

| Area | Status | Notes |
| --- | --- | --- |
| Tasks, reminders, snooze, done, dismiss | **Working** | SQLite, survives restarts |
| Durable scheduler | **Working** | Leases, retries, backoff, crash recovery, fake-clock tests |
| Nudge engine | **Working** | Deterministic rules: quiet hours, daily cap, cooldowns, calendar fit |
| Plain-text commands | **Working** | Parser first, small model only as a fallback. Several requests in one text |
| Policy and approvals | **Working** | Tiers A/B/C, default-deny scopes, hash-bound single-use approvals, kill switch |
| Usage and cost tracking | **Working** | Per call, per feature, budget alerts, hypothetical Claude-only comparison |
| iMessage | **Working on the Mac mini** | Reads your texts, replies, and texts reminders through `imsg`. Off by default |
| Model calls | **Working through OpenRouter** | Mock provider by default; live since 2026-11-17 |
| launchd service | **Running on the Mac mini** | LaunchAgent from `scripts/launchd/`, also serves the dashboard |
| Local dashboard and CLI | **Working** | Loopback only, token protected |
| Keychain lookup | **Written, not verified** | The Mac uses `.env` for now |
| Google Calendar | **Mocked** | In-memory mock behind the real interface. Adapter not written |
| Calendar writes, cart, orders, outside messages | **Mocked** | Tools exist so the approval flow can be exercised. They have no real effect |
| Shopping, Marketplace, travel, bookings | **Not implemented** | Phases 3 and 4 in [docs/roadmap.md](docs/roadmap.md) |
| OpenClaw skill | **Kept for reference, unused** | HomePilot handles iMessage itself |

HomePilot was designed to run beside an existing [OpenClaw](https://docs.openclaw.ai) install
on the same Mac without touching it. A read-only audit found no iMessage channel there, and
routing texts through a general-purpose agent with a shell is a risk this project avoids, so
HomePilot talks to `imsg` directly. Its report is not in this repository.

## Quick start

Needs Node.js 22.13 or newer. No native build step and no API key.

```bash
npm install
npm run check      # typecheck + 166 tests
npm run demo       # 13-step dry-run walkthrough on a throwaway database
```

Try it by hand (still dry-run, still no key):

```bash
cp .env.example .env
npm run build
./bin/homepilot init
./bin/homepilot say "remind me to call the dentist tomorrow at 10am"
./bin/homepilot say "I need a haircut sometime this week"
./bin/homepilot task list
./bin/homepilot run            # the scheduler loop; Ctrl+C to stop
```

In another terminal, `./bin/homepilot outbox` shows what would have been sent. To run it for
real on a Mac (iMessage, launchd, dashboard), follow [docs/operations.md](docs/operations.md).

## Commands

`./bin/homepilot help` prints the full list. The ones used most:

| Command | What it does |
| --- | --- |
| `say "<text>"` | Send a message exactly as a text would arrive |
| `task add / list / done / dismiss / snooze` | Direct task management |
| `run [--interval N]` | Scheduler loop, iMessage listener and dashboard (what launchd runs) |
| `tick` | Run everything that is due now, once |
| `nudges` | Show what the nudge engine would do right now and why. Sends nothing |
| `outbox` | Notifications (recorded, not sent, in dry-run) |
| `pause` / `resume` | Kill switch for all notifications and actions |
| `approvals`, `permissions`, `events` | Safety state and audit trail |
| `health`, `usage`, `usage export` | Status, cost report, raw export (CSV or JSON) |
| `models sync` | Refresh model prices from OpenRouter's public catalog (no key needed) |
| `imessage status`, `imessage send-test` | Check the iMessage setup, send one test text |
| `serve` | Dashboard only, at `http://127.0.0.1:8787` |
| `backup [DIR]` | Consistent copy of the database |

Things you can text: "remind me to X tomorrow at 10am", "I need to X before Friday", "tasks",
"X done", "done with X and Y", "going to X now", "snooze that until tomorrow 8am", "dismiss X",
"what should I do with my free hour?", "pause", "resume", "usage", "approve CODE", "deny CODE".
Several of these can go in one text.

When a model, not the parser, understood a message, the reply ends with `(read by <model>)`,
naming the model that actually answered. Turn that off with `HOMEPILOT_REPLY_SHOWS_MODEL=false`.

## Why OpenRouter

HomePilot reaches every model through [OpenRouter](https://openrouter.ai), a single
OpenAI-compatible API in front of models from many vendors. For a project like this, where model
calls are rare, small and cost-sensitive, that buys several things.

**One adapter, many vendors.** `src/models/openrouter.ts` is about 170 lines and speaks one
endpoint (`/chat/completions`) with one key. There is no SDK per vendor, and the default model
lists already mix DeepSeek, Tencent, OpenAI, Google and Anthropic models. `OPENROUTER_BASE_URL`
can point the same adapter at any other OpenAI-compatible endpoint.

**A model per job, not one model for everything.** Requests carry a task class, and each class
has its own ordered list in `.env`:

```bash
HOMEPILOT_MODEL_FAST=deepseek/deepseek-v4.1-flash-1017,tencent/hy4-flash
HOMEPILOT_MODEL_BALANCED=openai/gpt-6.1-terra,google/gemini-4-hydrogen
HOMEPILOT_MODEL_PREMIUM=anthropic/claude-fable-5.2
```

Reading a text the parser missed is a "fast" job, so it goes to a cheap, quick model; a later
planning feature can use "premium" without changing what the fast path costs. Swapping a model is
a one-line config change with no code change, which makes it cheap to compare models on real
traffic. Today only the fast tier is used.

**Fallback across vendors.** The router (`src/models/router.ts`) tries the first model, retries
within a cap, then moves to the next one in the list. Because the next one is usually from a
different vendor, one provider's outage or rate limit does not stop HomePilot from reading a
text. Auth and out-of-credit errors stop immediately, since every model behind the same key
would fail the same way. Every attempt is recorded, including the fallbacks.

**Real costs, not guesses.** OpenRouter returns the amount charged with each response
(`usage.cost`), so the cost report uses the provider's own figure and only falls back to a price
table when none is returned. Its public model catalog needs no key, so `homepilot models sync`
keeps that price table current. OpenRouter also lets you set a **credit limit on each key**,
which is the ceiling that still holds if HomePilot's own monthly budget check had a bug. Using a
separate key for HomePilot keeps its spend apart from anything else on the same machine.

**The trade-offs.** Requests take one extra network hop, and OpenRouter is a third party that
sees the text being classified. HomePilot limits what it sends to the one message it could not
parse, cut to 1,000 characters, and stores no prompts or responses. OpenRouter is billed per token
from prepaid credit, separately from any Claude or ChatGPT subscription. The provider sits behind
a small `ModelProvider` interface (`src/models/types.ts`), so calling a vendor directly would be
one more adapter rather than a rewrite.

What the cost numbers mean, and the "what would this have cost on Claude" comparison, are
explained in [docs/cost-methodology.md](docs/cost-methodology.md). In practice the bigger saving
is not the cheaper model: it is the work that never reaches a model at all.

## Credentials

**The tests, the demo and dry-run mode need no credentials at all.** Never paste a key into a
chat, a ticket or a commit; `.env` is git-ignored.

| Credential | Needed for | Where to get it | Where to put it |
| --- | --- | --- | --- |
| **OpenRouter API key** | Real model calls (`HOMEPILOT_MODEL_PROVIDER=openrouter`) | https://openrouter.ai/keys. Set a credit limit on the key | `OPENROUTER_API_KEY=` in `.env`, or the Keychain (below) |
| **Dashboard token** | The dashboard | Generate one: `openssl rand -hex 32` | `HOMEPILOT_API_TOKEN=` in `.env` |
| **Your iMessage handle** | The allowlist of who may text commands, and where reminders go | Your phone number or Apple ID email | `HOMEPILOT_ALLOWED_SENDERS` and `HOMEPILOT_NOTIFY_HANDLE` in `.env`. Not a secret, but personal |
| **Google OAuth client** | Phase 2 calendar (not written yet) | Google Cloud Console, "Desktop app" client | Placeholders in `.env.example`. Do not create one yet |

HomePilot reads the environment first, then the macOS Keychain under service `homepilot`
(written but not yet verified on a Mac). To store a key there without it landing in your shell
history:

```bash
security add-generic-password -U -s homepilot -a OPENROUTER_API_KEY -w
```

## Documentation

- [docs/architecture.md](docs/architecture.md): design, diagram, delivery guarantees, risks and assumptions
- [docs/security-model.md](docs/security-model.md): tiers, approvals, prompt injection, known gaps
- [docs/cost-methodology.md](docs/cost-methodology.md): how costs and the Claude-only comparison are calculated
- [docs/operations.md](docs/operations.md): install, iMessage setup, launchd, dashboard, backup, uninstall
- [docs/integration-matrix.md](docs/integration-matrix.md): what is reused from OpenClaw and what HomePilot builds
- [docs/roadmap.md](docs/roadmap.md): phases and what each is waiting on

## Layout

```
src/
  app.ts                 composition root: wires everything, owns the message handler
  cli.ts                 command-line interface
  config.ts, secrets.ts  validated configuration; environment, then Keychain
  clock.ts, time.ts      injectable clock; time-zone maths and the date parser
  db/                    SQLite wrapper and migrations
  domain/                tasks, reminders, agenda, preferences, approvals, audit events
  scheduler/             durable job queue
  notify/                outbox and delivery channels
  nudges/                deterministic nudge engine
  intent/                command parser and the model fallback contract
  models/                router, OpenRouter adapter, mock provider, price book
  telemetry/             usage recording, reports, export
  tools/                 policy engine, executor, built-in tools
  api/                   loopback HTTP API and dashboard
  integrations/          imessage (imsg), google-calendar (mock), openclaw (unused skill)
scripts/                 demo, read-only host audit, launchd template
tests/                   166 tests, all offline
```

## Tests

```bash
npm run check
```

All tests are offline and use a fake clock; CI runs the same command on every push and pull
request. The end-to-end acceptance test is `tests/acceptance.test.ts`: a task is saved to a file
database, the database is closed and reopened, the reminder fires exactly once at its due time,
the outcome is recorded, and the run is logged as deterministic (no model used).

## License

Copyright (c) 2026 Cole Bui. All rights reserved. The code is public so it can be read and
evaluated; no license is granted to copy, modify or redistribute it.
