# Roadmap

## Phase 0: read-only audit. **Blocked**

The Mac mini was not reachable from the session that built Phase 1.

- Done: reuse-or-build matrix from public docs ([integration-matrix.md](integration-matrix.md)),
  architecture and risk list ([architecture.md](architecture.md)), an audit script.
- Not done: anything tied to the actual machine.
- To unblock: run `bash scripts/audit-openclaw.sh` on the Mac mini, or connect the Mac so it can
  be inspected directly. Then update the matrix with what is actually installed.

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
| OpenRouter adapter and mock provider | Done (never called live) |
| Per-call telemetry, budget, Claude-only baseline | Done |
| One working command path | Done: CLI and loopback API. OpenClaw skill is drafted, not installed |
| End-to-end dry-run flow | Done |
| Usage and health reporting | Done: CLI and dashboard |
| Tests and README | Done: 130 tests |

Left over from Phase 1, all needing the Mac: verify Keychain lookup, verify the launchd
template, one supervised live OpenRouter call.

## Phase 2: iMessage and Google Calendar. **Not started**

Order matters here; each step is small and reversible.

1. Finish Phase 0.
2. Settle the agent-shell question in [security-model.md](security-model.md) (known gap 1).
3. With your approval, install the skill and send one test message. Inbound path done.
4. Choose and build the outbound channel (how HomePilot asks OpenClaw to send one text without a
   model turn). Send one real reminder to yourself. Check for duplicates across a restart.
5. Google Calendar read-only: OAuth desktop flow, tokens in Keychain, real adapter behind the
   existing `CalendarProvider` interface. Write scope only after you ask for it.
6. Daily briefing and calendar-aware nudges on real data.

Needs from you: the audit output, the handle to allowlist, a Google OAuth client, and a yes
before anything is installed into OpenClaw or sent.

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
- A dashboard view for approving requests with a button rather than typing the code.
- Move the OpenRouter adapter to streaming if long outputs are ever needed.
