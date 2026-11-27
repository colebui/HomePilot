# HomePilot dashboard

A Next.js dashboard for the HomePilot assistant: what's due today, what's coming up, what the
assistant did, where your money went this month, and what the assistant itself costs to run.

The HomePilot service (the parent folder) stays the source of truth. This app only reads its
loopback API and sends it the same commands you could text.

```
 Browser ──▶ Next.js (this folder)            ──▶ HomePilot service on 127.0.0.1:8787
             Server Components fetch data         SQLite, scheduler, iMessage, model calls
             Server Actions send commands         Bearer token, Host/Origin checks
             The API token never reaches the browser
```

## Pages

| Page | What it answers |
|---|---|
| **Today** | What needs doing now, what's overdue, reminders going out next, approvals waiting, and a box to type a command as if texting |
| **Upcoming** | The next reminders and dated tasks, grouped by day |
| **Activity** | Everything HomePilot did, newest first, filterable by tasks, reminders, texts, money or system |
| **Spend** | Your spending this month (budget pace, day-to-day chart, categories, top places, recent expenses) and, below it, the assistant's model spend, cap, latency and reliability by model, with a CSV export |

## Demo and live mode

| | Demo | Live |
|---|---|---|
| Data | Generated on the server, deterministic, no personal data | The HomePilot service's API |
| Sign-in | None | The service's API token, swapped for a signed 12-hour cookie |
| Changes | Kept in memory, lost on restart | Saved by the service |
| Chosen by | `HOMEPILOT_MODE=demo`, or no token set | `HOMEPILOT_MODE=live`, or a token set |

## Settings

Put these in `web/.env.local` (git-ignored). `web/.env.example` lists them.

| Variable | Default | Meaning |
|---|---|---|
| `HOMEPILOT_MODE` | `live` if a token is set, else `demo` | Which data source to use |
| `HOMEPILOT_API_URL` | `http://127.0.0.1:8787` | Where the service listens |
| `HOMEPILOT_API_TOKEN` | none | The same value as `HOMEPILOT_API_TOKEN` in the service's `.env`. Required in live mode |
| `DASHBOARD_SESSION_SECRET` | derived from the token | Signs session cookies. Set it (32+ characters) to sign everyone out without changing the token |

## Run it

Demo, no service needed:

```bash
cd web
npm ci
npm run dev            # http://localhost:3000
```

Live, on the Mac that runs the service (the service must already serve its API, see
[docs/operations.md](../docs/operations.md#dashboard)):

```bash
cd web
npm ci
printf 'HOMEPILOT_API_TOKEN=%s\n' "$(grep '^HOMEPILOT_API_TOKEN=' ../.env | cut -d= -f2)" > .env.local
chmod 600 .env.local
npm run build
npx next start -H 127.0.0.1 -p 3000
```

Open `http://127.0.0.1:3000` and sign in with the token. Keep it on loopback; to look from
another device, use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 you@mac-mini`).

## How it's built

- **Next.js 16 App Router** with Cache Components. Pages render a static shell and stream the
  data sections behind `<Suspense>`, with skeletons in the same shape.
- **One data layer.** `src/lib/homepilot/source.ts` defines `HomePilotSource`; the live
  version calls the API with a timeout and validates every response with zod, and the demo
  version returns generated data. Errors are typed (unreachable, unauthorized, bad response),
  and each section says what to check instead of failing the whole page.
- **Server Actions** for commands, marking tasks done, approvals and removing an expense. Task
  lists update optimistically and roll back if the service says no.
- **Auth** is checked twice: optimistically in `src/proxy.ts`, and again where data is read
  (`src/lib/server/homepilot.ts`). Cookies are HttpOnly, SameSite Strict, HMAC-signed with
  Web Crypto, and the token is compared in constant time.
- **Charts** are plain React and CSS: one series per chart, a hover and focus tooltip, a
  screen-reader table, and status shown with a word as well as a color. Light and dark themes
  are chosen separately, not inverted.

## Tests

```bash
npm run check          # eslint, tsc and vitest (unit, component and contract tests)
npm run build && npm run test:e2e   # Playwright on desktop and phone, demo mode
```

The contract test parses `tests/fixtures/api-samples.json` with the dashboard's schemas. CI
regenerates that file from the service at the same commit (`npm run api-samples` in the parent
folder), so a change to a response shape on either side fails the build.
