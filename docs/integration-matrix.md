# Integration matrix: reuse from OpenClaw, or build

## Verification status

The read-only Phase 0 audit has been run on the host. Its report stays in `data/`, which is
git-ignored: details of the host's setup are deliberately not published in this repository.

What came out of it: OpenClaw had no iMessage channel configured, so there was nothing to reuse
for texts, and routing texts through a general-purpose agent that can run shell commands is a
risk this project avoids. **Decision: HomePilot handles iMessage itself** through `imsg`, and
OpenClaw is left untouched.

Rows below that say "docs only" or "No" were not checked on the machine.

## Reuse or build

| Capability | Decision | Why | Verified? |
| --- | --- | --- | --- |
| Receiving and sending iMessages | **Build** (changed after the audit) | No OpenClaw iMessage channel was configured, and texts should never reach a shell-capable agent. HomePilot talks to `imsg` itself | imsg interface: docs only, tested against a fake |
| Conversational agent, model login, channels | **Reuse OpenClaw, do not change** | It is your working setup. HomePilot never edits `~/.openclaw`, the default model, or agents | No |
| Entry point from a text to HomePilot | **Build** (changed after the audit) | `ImessageListener` reads texts directly. The OpenClaw skill draft in `src/integrations/openclaw/skill/homepilot/` is kept for reference but not used | Tests only |
| Task and reminder storage | **Build** | Needs a schema, state transitions, idempotency and an audit trail that HomePilot controls | Yes (tests) |
| Scheduling | **Build** | OpenClaw automations wake the agent (a model turn) per its docs. Reminders must fire with no model and no cost | Build: yes. The OpenClaw claim: no |
| Nudge decisions | **Build** | Deterministic rules that can be tested and explained | Yes (tests) |
| Policy, approvals, kill switch | **Build** | Must not depend on any model, including OpenClaw's agent | Yes (tests) |
| Model routing and cost tracking | **Build** | HomePilot needs per-feature cost and a budget ceiling for its own calls. OpenClaw's model settings stay as they are | Yes with mocks. Live: no |
| Google Calendar | **Build, later** | Read-only OAuth first. If the audit shows OpenClaw already has a calendar plugin with suitable access, reuse it instead | Not implemented |
| Web browsing for research | **Decide after audit** | Reuse OpenClaw's browser tooling if present; treat every page as untrusted | Not implemented |

## Integration status

| Integration | State | What exists | What is missing |
| --- | --- | --- | --- |
| OpenClaw skill | Prepared, not installed, not planned | `SKILL.md` that pipes the user's words to `homepilot say --stdin --channel openclaw` | Not needed: HomePilot handles iMessage directly |
| iMessage outbound (reminders, nudges) | Implemented, not yet run on the Mac | `ImessageChannel` sends through `imsg rpc` to one configured handle | Install imsg, grant permissions, one test send |
| iMessage inbound | Implemented, not yet run on the Mac | `ImessageListener`: allowlist, one-to-one chats only, at-most-once, resume cursor, hourly cap | Same as above, plus a separate Apple ID on the Mac |
| OpenRouter | Written, never called live | Adapter, router, fallbacks, cost capture, price sync | An API key and one supervised live call |
| Google Calendar | Mock only | Provider interface, conflict and free-time maths | OAuth flow, token storage in Keychain, real adapter |
| H-E-B, Amazon | Not implemented | Mock cart and order tools for the approval flow | Everything. No official consumer ordering API is assumed |
| Facebook Marketplace | Not implemented | Nothing | A compliant approach; no scraping is assumed |
| Travel, bookings | Not implemented | Nothing | Phase 4 |
| launchd | Template only | `scripts/launchd/*.plist.template` | Install and verify on the Mac |
| macOS Keychain | Written, unverified | `src/secrets.ts` | First run on the Mac |

## OpenClaw facts relied on (all unverified against your install)

- Config lives at `~/.openclaw/openclaw.json`; `openclaw config get <key>` reads one value.
- CLI includes `status`, `health`, `doctor`, `skills list`, `backup create`, `automations`.
- Skills load from `~/.openclaw/workspace/skills/<name>/SKILL.md` and can call local commands
  through the agent's `exec` tool.
- Automations wake the agent and can deliver to a channel.
- iMessage goes through `imsg`; richer features use a "private API" mode. **Whether that mode
  needs any change to System Integrity Protection is unknown.** HomePilot will not ask for SIP
  to be changed, and nothing in Phase 1 or the Phase 2 plan requires it.

## Questions the audit must answer before any integration

1. Which OpenClaw version is installed, and is the gateway healthy?
2. Is the iMessage channel working today, and with which handle?
3. Does the agent have an unrestricted `exec` tool? (Security: see [security-model.md](security-model.md).)
4. How can a local process ask OpenClaw to send one iMessage without a model turn?
5. Is there already a calendar or browser plugin worth reusing?
6. Where should this repository live on the Mac? Recommended: `~/dev/homepilot`, outside any
   directory OpenClaw manages.
