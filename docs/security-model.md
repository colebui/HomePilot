# Security model

The rule everything else follows from: **a model can suggest, only code can permit, and only you
can approve.** No model output, and no text from a web page, can cause an action by itself.

## Defaults

- `HOMEPILOT_DRY_RUN=true`. External tools record what they would do and do nothing.
- Only two permission scopes are granted out of the box: `tasks.write` and `notify.send`.
  Everything else is denied until you run `homepilot permissions grant <scope>`.
- The dashboard listens on 127.0.0.1 only and needs a token of at least 16 characters.
- The only allowed sender is `local-cli`. Messages from anyone else are refused and logged.

## Tiers

| Tier | Meaning | Examples | Behaviour |
| --- | --- | --- | --- |
| A | Internal, reversible | create a task, queue a reminder to yourself | Runs automatically if its scope is granted |
| B | Reversible outside effect | create a calendar event, add to cart | Needs approval (or auto if you set `HOMEPILOT_TIER_B_MODE=auto`) |
| C | Money, messages to other people, anything irreversible | place an order, text someone else | Always needs approval for that exact action. No setting turns this off |

## How a tool call is decided

In order, in `src/tools/policy.ts`:

1. Kill switch on? Deny.
2. Did the request originate from third-party content (`untrusted_content`)? Deny.
3. Scope not granted? Deny.
4. Tier A: allow. Tier B: approval or auto. Tier C: approval.

Each decision is written to the audit log with its reason.

## Approvals

- An approval is bound to a SHA-256 hash of the tool name plus its exact arguments. Change the
  price, the retailer or the recipient and the approval no longer matches.
- It has a short code, expires (15 minutes by default) and can be used once.
- A bare "yes" does not approve a tier C action. You must send `approve CODE`.
- Consuming an approval and recording the execution happen in one database transaction.
- Repeating the same request returns the recorded result. It does not act twice.

## Prompt injection

Text inside a web page, listing, email, calendar invite or message from another person is
**data**. The executor carries an `origin` with every tool call, and anything derived from such
content is tagged `untrusted_content` and denied outright, whatever tier and whatever it says.
`tests/policy.test.ts` and step 10 of the demo exercise this.

When a model is used to understand a message from you, it returns a small JSON object that is
validated against a schema. It cannot name a tool, set a date, or approve anything.

## Agent-relayed channels

When a message reaches HomePilot through an AI agent (the planned OpenClaw skill), the agent,
not you, typed the final text. So on channels listed in `HOMEPILOT_AGENT_CHANNELS` (default:
`openclaw`), HomePilot refuses `approve`, `deny` and `resume`. A model must never be able to say
yes for you or switch the kill switch back off. Approvals are given from the CLI or dashboard.

`pause` is accepted from any allowed channel: stopping is always safe.

## Secrets and privacy

- Secrets are read from the environment or the macOS Keychain, never from the database.
- `.gitignore` excludes `.env*`, databases, backups, logs and exports.
- Configuration errors name the setting, never its value.
- Model prompts and responses are not stored. The audit log redacts key-shaped values.
- The audit script lists file names in `~/.openclaw` and never opens one.

## Kill switch

`homepilot pause` (or texting "pause", or the dashboard button) stops all deliveries and all
tool executions immediately. Reminders that come due are held, not lost, and are delivered once
after `homepilot resume`.

## Known gaps, stated plainly

1. **The policy layer is not a sandbox against the OpenClaw agent.** If that agent has an
   unrestricted shell tool, it can run any `homepilot` command, including without
   `--channel openclaw`, and could therefore approve an action. The skill's instructions forbid
   this, but instructions to a model are not enforcement. Before the skill is installed, one of
   these needs to be true: the agent's shell is restricted to the single allowed command; or
   HomePilot's approvals move to a channel the agent cannot reach (for example the dashboard
   with its token held only by you). This is the main open security decision for Phase 2.
2. **Sender identity is only as good as the channel.** For iMessage, HomePilot will trust the
   handle OpenClaw reports. How reliably OpenClaw authenticates senders is unverified.
3. **No encryption at rest** beyond what the Mac provides (FileVault). The database holds task
   titles and notification text.
4. **The dashboard token is a single shared secret.** Fine for one person on one machine; not a
   multi-user design.
5. **Keychain and launchd paths are unverified on macOS.**

## What HomePilot will not do

- Change System Integrity Protection, or ask you to.
- Read, copy or modify OpenClaw's credentials or configuration.
- Send a real message, create a calendar event, change a cart or book anything during setup
  without asking first.
