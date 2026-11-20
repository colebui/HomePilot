# Roadmap

## Phase 0: read-only audit. **Done**

Run on the host on 2026-11-16. The report stays in the git-ignored `data/` folder. Outcome:
HomePilot handles iMessage itself; OpenClaw is not changed (see
[integration-matrix.md](integration-matrix.md)).

## Phase 1: real MVP. **Complete in dry-run**

Acceptance test from the spec: a task is persisted, survives a simulated restart, fires once at
its due time in a controlled test, records its outcome, and logs model usage or deterministic
execution, with no paid key. Met by `tests/acceptance.test.ts`; shown by `npm run demo`.

| Item | State |
| --- | --- |
| TypeScript repo with validated configuration | Done |
| SQLite schema and migrations | Done |
| Task and reminder CRUD, status changes, snooze | Done |
| Durable scheduler, restart recovery, fake-clock tests | Done |
| Policy and approval framework, dry-run tool execution | Done |
| OpenRouter adapter and mock provider | Done (live since 2026-11-17) |
| Per-call telemetry, budget, Claude-only baseline | Done |
| One working command path | Done: CLI and loopback API. OpenClaw skill is drafted, not installed |
| End-to-end dry-run flow | Done |
| Usage and health reporting | Done: CLI and dashboard |
| Tests and README | Done (166 tests now) |

Left over from Phase 1: verify the Keychain lookup on the Mac. The launchd service and live
OpenRouter calls have run there since 2026-11-17.

## Phase 2: iMessage and Google Calendar. **iMessage working, calendar not started**

1. Done: Phase 0.
2. Done and verified on the Mac (2026-11-17): HomePilot reads your texts and replies through
   `imsg`, texts reminders and nudges, and runs as a launchd service that also serves the
   dashboard. Texts from the first days drove parser fixes: several tasks or requests in one text,
   times like "around 430", "X done" and "going to X now". See
   [operations.md](operations.md#imessage-setup).
3. Google Calendar read-only: OAuth desktop flow, tokens in Keychain, real adapter behind the
   existing `CalendarProvider` interface. Write scope only after you ask for it.
4. Daily briefing and calendar-aware nudges on real data.

Still needed for the calendar: a Google OAuth client, and a yes before anything is installed.

## Phase 3: shopping and monitored deals. **Not started**

Wishlist with target prices, scheduled checks with dedupe, and only price sources that can be
verified. H-E-B and Amazon cart actions only where an authorised method exists; otherwise
HomePilot builds the list and says plainly that it cannot place the order. Facebook Marketplace
needs a compliant approach before any work starts.

## Phase 4: travel, appointments, multi-step workflows. **Not started**

Research providers, itinerary drafts, approval-gated bookings, workflows that pause for an
approval and resume. The approval and idempotency pieces already exist.

## Phase 5: personalisation and optimisation. **Not started**

Nudge timing learned from your explicit feedback, model comparisons on real traffic (cost,
success, speed, quality), optional semantic memory, a fuller dashboard.

## Smaller items noted along the way

- Recurring tasks (the schema allows for it; no rule engine yet).
- "Missed while offline" summary after the Mac wakes.
- Log rotation for the launchd service.
- Viewing the dashboard from a phone (for example over Tailscale) without exposing the port.
- A cheap model that rates how hard a request is and routes it to the fast, balanced or premium
  tier, compared against a fixed model on real traffic.
- A dashboard view for approving requests with a button rather than typing the code.
- Move the OpenRouter adapter to streaming if long outputs are ever needed.
