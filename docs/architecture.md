# Architecture

Status: running on a Mac mini since 2026-11-17 (iMessage, OpenRouter, launchd). Calendar,
shopping and bookings are still mocked or not written; see the README status table.

## Shape

```
              you (iMessage on your phone)         you (terminal / browser)
                        |                                  |
              +---------v----------+                       |
              | Messages on the Mac|  separate Apple ID    |
              |  + `imsg rpc`      |                       |
              +---------+----------+                       |
                        | ImessageListener: allowlist,     |
                        | 1:1 chats, at-most-once          |
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
        |   channel: dry-run (records only), or iMessage via imsg      |
        |                                                              |
        |   SQLite file (WAL)   audit events   loopback API + dashboard |
        +--------------------------------------------------------------+
```

One process, one SQLite file, no network listener except the optional dashboard on 127.0.0.1.

## Decisions

**HomePilot is a separate repository and process, beside OpenClaw.** Nothing is written under
`~/.openclaw`. HomePilot reads and sends texts itself through `imsg`, so no AI agent sits between
your phone and the code that acts on your texts. Removing HomePilot leaves OpenClaw exactly as it
was. (A skill that would let OpenClaw call HomePilot is kept in `src/integrations/openclaw/` but
is not used.)

**SQLite through Node's built-in `node:sqlite`.** No native add-on to compile, so `npm install`
cannot fail on a toolchain problem. It is wrapped in one class (`src/db/database.ts`) so the
driver can be swapped. Node still labels the module experimental; that is a known risk (below).

**HomePilot owns its scheduler rather than using OpenClaw automations.** According to OpenClaw's
docs, an automation "wakes the agent", which is a model turn. A reminder that fires at 9:00
should cost nothing and should not depend on a model being reachable.

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
  channel does. iMessage cannot, so the worst case there is a rare duplicate text after a crash
  at exactly the wrong moment. When imsg reports that a send "may have completed", HomePilot
  counts it as sent rather than risk a duplicate.
- **Incoming texts are at-most-once.** Each text's id is recorded before HomePilot acts on it.
- **Failed jobs** back off exponentially and stop after a bounded number of attempts, ending in
  a `dead` state that shows up in `homepilot health`.
- **Tool executions are idempotent by key.** Repeating a request with the same key returns the
  recorded result instead of acting twice.

## Data

Migrations (`src/db/migrations.ts`) create: `tasks`, `reminders`, `preferences`, `events`
(append-only audit), `approvals`, `tool_executions`, `jobs`, `job_runs`, `notifications`,
`llm_calls`, `workflow_runs`, `other_costs`, `model_prices`, `system_state`, and
`imessage_inbound` (message ids and masked senders only, never the text).

Prompts and model responses are **not** stored. `llm_calls` keeps counts, cost, timing, model
and feature only. The audit log redacts values that look like secrets.

## Risks and assumptions

| # | Risk or assumption | Consequence | Mitigation |
| --- | --- | --- | --- |
| 1 | iMessage depends on `imsg` and on Messages' local database, neither of which is a stable Apple API | A macOS or imsg update could break texts | `homepilot run` exits when imsg dies so launchd restarts it; `homepilot health` and `imessage status` show the problem |
| 2 | OpenClaw facts come from its public docs (2026-11-16), not from the installed version | Matters only if the unused skill is ever installed | Every such fact is labelled unverified in [integration-matrix.md](integration-matrix.md) |
| 3 | `node:sqlite` is still marked experimental by Node | An API change in a future Node release | `package.json` requires Node 22.13+; test before moving to a new major; one wrapper class to change |
| 4 | Keychain lookup has not been run on macOS (the Mac uses `.env`) | First use may need a fix | Small and isolated in `src/secrets.ts` |
| 5 | Model output can be malformed or wrong | A text is misread | Output is schema-checked, retried within caps, and can only classify; the reply says which model read it |
| 6 | Seeded model prices and Claude list prices are dated snapshots | Estimates drift | `homepilot models sync`; every report prints the price date |
| 7 | iMessage has no duplicate suppression at the channel | Rare duplicate text after a crash | Outbox dedupe inside HomePilot; uncertain sends count as sent |
| 8 | Any local process running as the same user (including an AI agent with a shell) can run the `homepilot` CLI | The policy layer is not a sandbox against local code | See "Known gaps" in [security-model.md](security-model.md) |
| 9 | Default time zone is America/Chicago | Wrong times if that is not yours | Set `HOMEPILOT_TIMEZONE` |
| 10 | Single process, single machine | No reminders while the Mac is off or asleep | Overdue jobs run on wake; a "missed while offline" summary is a later item |
