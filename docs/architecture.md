# Architecture

Status: Phase 1. Built and tested in a Linux sandbox. Not yet run on the Mac mini.

## Shape

```
                 you (iMessage, later)            you (terminal / browser)
                        |                                  |
              +---------v----------+                       |
              |  OpenClaw gateway  |  untouched            |
              |  (existing setup)  |                       |
              +---------+----------+                       |
                        | skill: `homepilot say --stdin    |
                        |         --channel openclaw`      |
                        | (prepared, NOT installed)        |
        +---------------v----------------------------------v-----------+
        |                         HomePilot                            |
        |                                                              |
        |   handleMessage --> deterministic parser --(unknown)--> model router
        |        |                                                  |  |
        |        v                                                  |  +--> OpenRouter (off by default)
        |   tasks / reminders / preferences                         |  +--> mock provider (default)
        |        |                                                  v
        |        v                                             usage telemetry
        |   durable scheduler --> handlers --> nudge engine         |
        |        |                    |            ^                v
        |        |                    v            |           cost report, budget alerts
        |        |               tool executor     +-- calendar provider (mock / not connected)
        |        |                    |
        |        |               policy engine --> approvals (hash-bound, single use)
        |        v                    |
        |     outbox  <---------------+
        |        |
        |        v
        |   channel: dry-run (records only)        iMessage channel: Phase 2
        |                                                              |
        |   SQLite file (WAL)   audit events   loopback API + dashboard |
        +--------------------------------------------------------------+
```

One process, one SQLite file, no network listener except the optional dashboard on 127.0.0.1.

## Decisions

**HomePilot is a separate repository and process, beside OpenClaw.** Nothing is written under
`~/.openclaw`. The only planned contact point is a skill directory that calls HomePilot's CLI.
Removing HomePilot leaves OpenClaw exactly as it was.

**SQLite through Node's built-in `node:sqlite`.** No native add-on to compile, so `npm install`
cannot fail on a toolchain problem. It is wrapped in one class (`src/db/database.ts`) so the
driver can be swapped. Node still labels the module experimental; that is a known risk (below).

**HomePilot owns its scheduler rather than using OpenClaw automations.** According to OpenClaw's
docs, an automation "wakes the agent", which is a model turn. A reminder that fires at 9:00
should cost nothing and should not depend on a model being reachable. This is a docs-level
finding and should be re-checked during the audit; if OpenClaw can run a plain command on a
schedule without a model turn, an adapter is a small addition.

**Deterministic code first, models last.** Dates, recurrence, quiet hours, cooldowns, scoring,
dedupe, retries, budgets and policy are ordinary code. A model is used only when the command
parser does not recognise a message, and then it only returns words (an intent, a title, a
phrase such as "next week"). HomePilot does the date arithmetic itself.

**Time is injected.** Nothing reads the system clock directly; everything takes a `Clock`. Tests
and the demo use a fake clock, which is how "fires once at its due time" is proven rather than
hoped for.

**Outbox for notifications.** A handler never sends. It inserts a row with a unique dedupe key,
and a separate step delivers it. A crash between the two cannot lose or duplicate a message
inside HomePilot.

**The policy layer does not involve a model.** A tool call is allowed, held for approval, or
denied by code, based on the tool's tier, the granted scopes, where the request came from, and
the kill switch. See [security-model.md](security-model.md).

## Delivery guarantees, stated precisely

- **Jobs are at-least-once.** A job is claimed with a compare-and-set update and a lease. If the
  process dies mid-run, the lease expires and the job runs again. Handlers are therefore written
  to be idempotent.
- **Notifications are exactly-once into the outbox** (unique key), and **at-least-once at the
  channel**. Each delivery carries an idempotency key so a channel can drop repeats. The dry-run
  channel does. Whether the real iMessage path can is unverified and is a Phase 2 question; the
  worst case is a rare duplicate text after a crash at exactly the wrong moment.
- **Failed jobs** back off exponentially and stop after a bounded number of attempts, ending in
  a `dead` state that shows up in `homepilot health`.
- **Tool executions are idempotent by key.** Repeating a request with the same key returns the
  recorded result instead of acting twice.

## Data

One migration (`src/db/migrations.ts`) creates: `tasks`, `reminders`, `preferences`, `events`
(append-only audit), `approvals`, `tool_executions`, `jobs`, `job_runs`, `notifications`,
`llm_calls`, `workflow_runs`, `other_costs`, `model_prices`, `system_state`.

Prompts and model responses are **not** stored. `llm_calls` keeps counts, cost, timing, model
and feature only. The audit log redacts values that look like secrets.

## Risks and assumptions

| # | Risk or assumption | Consequence | Mitigation |
| --- | --- | --- | --- |
| 1 | The Mac mini and OpenClaw were not inspected. Version, config, channels and agent permissions are unknown | Any integration detail may be wrong | Run `scripts/audit-openclaw.sh`; integrate only after reading the result |
| 2 | OpenClaw facts come from its public docs (2026-11-16), not from the installed version | Commands may differ | Every such fact is labelled unverified in [integration-matrix.md](integration-matrix.md) |
| 3 | `node:sqlite` is still marked experimental by Node | An API change in a future Node release | `package.json` requires Node 22.13+; test before moving to a new major; one wrapper class to change |
| 4 | Keychain lookup and the launchd template were never run on macOS | First run on the Mac may need a fix | Small, isolated, and documented in [operations.md](operations.md) |
| 5 | The OpenRouter adapter was tested against a fake server only | A response field may differ in practice | First live call should be made with a low credit limit on the key; malformed output is already handled |
| 6 | Seeded model prices and Claude list prices are dated snapshots | Estimates drift | `homepilot models sync`; every report prints the price date |
| 7 | iMessage duplicate suppression at the channel is unverified | Rare duplicate text after a crash | Idempotency key is already passed; decide in Phase 2 |
| 8 | If the OpenClaw agent has an unrestricted shell, HomePilot's policy layer is not a wall against that agent | The agent could call the CLI in ways the skill forbids | See "Known gaps" in [security-model.md](security-model.md); settle before the skill is installed |
| 9 | Default time zone is America/Chicago | Wrong times if that is not yours | Set `HOMEPILOT_TIMEZONE` |
| 10 | Single process, single machine | No reminders while the Mac is off or asleep | Overdue jobs run on wake; a "missed while offline" summary is a later item |
