# Cost methodology

What the numbers in `homepilot usage` and the dashboard mean, and what they do not.

## What is recorded

Every model attempt writes one row to `llm_calls`: time, feature, model, task class, outcome
(ok, invalid output, error, blocked by budget; timeouts are flagged separately), whether it was a retry or a fallback,
latency, input, output and cached token counts, cost, and how that cost was arrived at.
**Prompt and response text is not stored.**

Every unit of work (a message handled, a reminder fired, a nudge evaluated) writes one row to
`workflow_runs`, marked **deterministic** when no model was involved. That is how the report can
say what share of the work cost nothing.

Costs that are not model calls (a paid API, for example) go in `other_costs`. Nothing writes to
it yet.

## Four kinds of cost, never mixed

| Kind | Meaning | Counts toward spend and budget? |
| --- | --- | --- |
| `provider_reported` | The charge OpenRouter returned with the response (`usage.cost`). The closest thing to an invoice | Yes |
| `estimated` | Token counts multiplied by a price table, used when the provider reported no charge | Yes, and labelled as an estimate |
| `simulated` | A mock-provider call. Never billed. Exists so the demo has numbers | No |
| `none` | The call produced no usage (failed before reaching a model) | No |

Reports show provider-reported and estimated amounts separately. If a report contains simulated
data it says so at the top.

The authoritative figure for what you were charged is always the OpenRouter activity page.
HomePilot's numbers are a local record for attribution, not an invoice.

## Prices

- **OpenRouter prices** are seeded from the public catalog as observed on 2026-11-16 so that
  estimates work offline. `homepilot models sync` replaces them with current values (no key
  needed). Every price row carries its source and date, and the report prints them.
- **Claude API list prices**, used only for the comparison below, are a snapshot dated
  2026-11-03 held in `src/models/pricing.ts`. Check the current Anthropic price list before
  relying on them.
- Where a cache-read price is unknown, 10% of the input price is assumed, and the report says so.

The default model names in `.env.example` are examples picked from the catalog on that date.
They are not a recommendation based on measured quality. Phase 5 is where models get compared
on real data.

## The Claude-only comparison

The report answers: "what would these same calls have cost at Claude API list prices?"

```
hypothetical = sum over calls of
    uncached input tokens x baseline input price
  + cached input tokens   x baseline cache-read price
  + output tokens         x baseline output price
```

The baseline model is `HOMEPILOT_BASELINE_MODEL` (default `claude-opus-5-5`).

Read it with these limits in mind. The report prints them every time:

- **It is hypothetical.** A different model would have used a different number of tokens.
- **It is token-equivalent only.** It does not show that the cheaper model gave an answer of
  equal quality.
- **It compares against pay-per-token API pricing**, not a flat-rate Claude subscription, which
  is billed differently and may make the comparison meaningless for you.
- Failed and retried calls are included on both sides when they consumed tokens.
- With only mock calls, the comparison is labelled as demonstration data.

The larger saving is usually not the model swap. It is the work that never reached a model at
all, which is why the deterministic share of workflows is reported next to it.

## Budget

- `HOMEPILOT_MONTHLY_BUDGET_USD` is a hard ceiling for HomePilot's own model calls. It is
  checked before every attempt; once reached, calls are refused and recorded with outcome
  `blocked_budget`. Commands the deterministic parser understands keep working; anything else
  gets "I didn't understand that, so I did nothing" until the next month or a higher ceiling.
- Alerts are raised once per threshold per calendar month (default 50%, 80%, 100%).
- The ceiling is enforced from HomePilot's local record. **Also set a credit limit on the
  OpenRouter key itself.** That is the limit that holds even if HomePilot has a bug.
- OpenClaw's own model spend is separate and is not visible to HomePilot.

## Export

```bash
./bin/homepilot usage export --format csv --out usage.csv
./bin/homepilot usage export --format json
```
