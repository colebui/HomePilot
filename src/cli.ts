#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createApiServer, listen } from './api/server.js';
import { App } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { runDemo } from './demo.js';
import { fetchOpenRouterPrices } from './models/openrouter.js';
import { resolveSecret } from './secrets.js';
import { exportLlmCalls, formatUsageReport } from './telemetry/report.js';
import { formatLocal, parseWhen } from './time.js';

const USAGE = `HomePilot (Phase 1 MVP)

Usage: homepilot <command> [args]

Talk to it
  say "<text>"                 Send a message exactly as a text would arrive
                               e.g. say "remind me to call the dentist tomorrow at 10am"
  say --stdin [--channel NAME] Read the message from standard input (used by the OpenClaw skill)

Tasks
  task add "<title>" [--due "<when>"] [--remind "<when>"] [--priority 1-4] [--minutes N]
  task list [--all]
  task done <id> | task dismiss <id> | task snooze <id> "<when>"

Scheduler
  init                         Create or upgrade the database
  tick                         Run everything that is due now, once
  run [--interval SECONDS]     Run continuously (this is what launchd will start)
  jobs                         Show the job queue
  nudges                       Show what the nudge engine would do right now (sends nothing)
  outbox [--limit N]           Show notifications (in dry-run they are recorded, not sent)

Safety
  pause | resume               Kill switch for notifications and actions
  approvals                    List approval requests
  permissions                  List tools and whether their permission scope is granted
  permissions grant|revoke <scope>
  events [--limit N]           Audit trail

Reporting
  health [--json]
  usage [--json]
  usage export --format csv|json [--out FILE]
  models sync                  Refresh model prices from OpenRouter's public catalog
  prefs | prefs set <key> <json> | prefs delete <key>

Other
  serve                        Local dashboard on 127.0.0.1 (needs HOMEPILOT_API_TOKEN)
  backup [DIR]                 Write a consistent copy of the database
  demo                         Run the end-to-end dry-run demonstration on a temporary database
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v;
}

function has(args: string[], name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command === 'demo') return runDemo();

  loadDotEnv();
  const config = loadConfig();
  const app = App.open({ config });
  const tz = config.timezone;
  const when = (text: string): Date => {
    const w = parseWhen(text, app.clock.now(), tz);
    if (!w) fail(`Could not understand the time "${text}". Try "tomorrow 9am", "friday 14:00", "in 2 hours" or "2026-12-01 09:00".`);
    return w.at;
  };

  let keepOpen = false;
  try {
    switch (command) {
      case 'init':
        console.log(`Database ready at ${resolve(config.dbPath)} (schema v${app.health().schemaVersion}).`);
        break;

      case 'say': {
        const channel = flag(args, 'channel') ?? 'cli';
        // --stdin lets a caller pass the message without putting it through shell quoting.
        const text = (has(args, 'stdin') ? readFileSync(0, 'utf8') : args.join(' ')).trim();
        if (!text) fail('Usage: homepilot say "<text>"   or   echo "<text>" | homepilot say --stdin [--channel NAME]');
        const r = await app.handleMessage({ sender: 'local-cli', channel, text });
        console.log(r.reply ?? '(no reply)');
        break;
      }

      case 'task': {
        const sub = args.shift();
        if (sub === 'add') {
          const due = flag(args, 'due');
          const remind = flag(args, 'remind');
          const priority = flag(args, 'priority');
          const minutes = flag(args, 'minutes');
          const title = args.join(' ').trim();
          if (!title) fail('Usage: homepilot task add "<title>" [--due "<when>"] [--remind "<when>"]');
          const { task, reminder } = app.addTask(
            {
              title,
              source: 'cli',
              ...(due ? { dueAt: when(due) } : {}),
              ...(priority ? { priority: Number(priority) } : {}),
              ...(minutes ? { estimatedMinutes: Number(minutes) } : {}),
            },
            { remindAt: remind ? when(remind) : undefined, actor: 'local-cli' },
          );
          console.log(`Created ${task.id}: ${task.title}${reminder ? ` (reminder ${formatLocal(reminder.fireAt, tz)})` : ''}`);
        } else if (sub === 'list') {
          const all = has(args, 'all');
          const list = app.tasks.list({ states: all ? ['open', 'snoozed', 'done', 'dismissed'] : ['open', 'snoozed'] });
          if (list.length === 0) console.log('No tasks.');
          for (const t of list) {
            const due = t.dueAt ? ` due ${formatLocal(t.dueAt, tz)}` : t.windowEnd ? ` by ${formatLocal(t.windowEnd, tz)}` : '';
            console.log(`${t.id}  [${t.state}] p${t.priority}  ${t.title}${due}${t.doNotRemind ? '  (reminders off)' : ''}`);
          }
        } else if (sub === 'done' && args[0]) {
          console.log(`Done: ${app.completeTask(args[0], 'local-cli').title}`);
        } else if (sub === 'dismiss' && args[0]) {
          console.log(`Dismissed: ${app.dismissTask(args[0], false, 'local-cli').title}`);
        } else if (sub === 'snooze' && args[0] && args[1]) {
          const until = when(args.slice(1).join(' '));
          console.log(`Snoozed "${app.snoozeTask(args[0], until, 'local-cli').task.title}" until ${formatLocal(until, tz)}`);
        } else {
          fail('Usage: homepilot task add|list|done|dismiss|snooze ...');
        }
        break;
      }

      case 'tick': {
        app.ensureNudgeLoop();
        console.log(JSON.stringify(await app.tick()));
        break;
      }

      case 'run': {
        const seconds = Number(flag(args, 'interval') ?? '15');
        if (!Number.isFinite(seconds) || seconds < 1) fail('--interval must be a number of seconds >= 1');
        app.ensureNudgeLoop();
        keepOpen = true;
        const h = app.health();
        console.log(`HomePilot running. Tick every ${seconds}s. Mode: ${h.dryRun ? 'dry-run' : 'LIVE'}. Model: ${h.modelProvider.name}. Ctrl+C to stop.`);
        app.scheduler.start(
          seconds * 1000,
          (err) => console.error(`[scheduler] ${err instanceof Error ? err.message : String(err)}`),
          async () => {
            const sent = await app.notifier.dispatchPending();
            app.system.set('last_tick', app.clock.now().toISOString());
            if (sent.sent > 0) {
              for (const n of app.notifier.list({ limit: sent.sent })) console.log(`[${n.dryRun ? 'dry-run ' : ''}${n.kind}] ${n.body}`);
            }
          },
        );
        const stop = (): void => {
          console.log('\nStopping. Pending jobs stay in the database and resume on next start.');
          app.close();
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        break;
      }

      case 'jobs': {
        console.log(JSON.stringify(app.scheduler.stats()));
        for (const j of app.scheduler.list({ states: ['pending', 'running', 'dead'], limit: 50 })) {
          console.log(`${j.id}  [${j.state}] ${j.type}  run ${formatLocal(j.runAt, tz)}  attempts ${j.attempts}/${j.maxAttempts}${j.lastError ? `  last error: ${j.lastError}` : ''}`);
        }
        break;
      }

      case 'nudges': {
        const d = await app.evaluateNudgesNow();
        console.log(`Decision: ${d.decision}${d.suppressed ? ` (${d.suppressed})` : ''}. ${d.calendarNote}.`);
        for (const c of d.candidates) console.log(`  score ${String(c.score).padStart(3)}  ${c.title}: ${c.reasons.join('; ')}`);
        for (const e of d.excluded) console.log(`  skipped   ${app.tasks.get(e.taskId)?.title ?? e.taskId}: ${e.why}`);
        break;
      }

      case 'outbox': {
        const limit = Number(flag(args, 'limit') ?? '20');
        const list = app.notifier.list({ limit });
        if (list.length === 0) console.log('No notifications yet.');
        for (const n of list) {
          console.log(`${formatLocal(n.createdAt, tz)}  [${n.kind}/${n.state}${n.dryRun ? '/dry-run' : ''}] ${n.body}${n.ackAction ? `  (you: ${n.ackAction})` : ''}`);
        }
        break;
      }

      case 'pause':
      case 'resume': {
        const r = await app.handleMessage({ sender: 'local-cli', channel: 'cli', text: command });
        console.log(r.reply);
        break;
      }

      case 'approvals': {
        const list = app.approvals.list();
        if (list.length === 0) console.log('No approval requests.');
        for (const a of list) {
          console.log(`${a.code}  [${a.state}] tier ${a.tier}  ${a.action}${a.target ? ` (${a.target})` : ''}${a.priceUsd !== null ? `  $${a.priceUsd.toFixed(2)}` : ''}  expires ${formatLocal(a.expiresAt, tz)}`);
        }
        break;
      }

      case 'permissions': {
        const sub = args.shift();
        if ((sub === 'grant' || sub === 'revoke') && args[0]) {
          if (sub === 'grant') app.policy.grant(args[0]);
          else app.policy.revoke(args[0]);
          app.events.record({ kind: `permission.${sub === 'grant' ? 'granted' : 'revoked'}`, actor: 'local-cli', data: { scope: args[0] } });
          console.log(`${sub === 'grant' ? 'Granted' : 'Revoked'} ${args[0]}.`);
        } else {
          console.log(`Tier B mode: ${config.policy.tierBMode}. Dry-run: ${config.dryRun}.`);
          for (const t of app.registry.list()) {
            const live = t.execute ? (t.external ? 'live integration' : 'internal') : 'MOCK (dry-run only)';
            console.log(`${t.name.padEnd(26)} tier ${t.tier}  scope ${t.scope.padEnd(20)} ${app.policy.isGranted(t.scope) ? 'granted' : 'NOT granted'}  ${live}`);
          }
        }
        break;
      }

      case 'events': {
        const limit = Number(flag(args, 'limit') ?? '30');
        for (const e of app.events.list({ limit }).reverse()) {
          console.log(`${e.ts}  ${e.kind.padEnd(22)} ${e.actor.padEnd(18)} ${e.subjectId ?? ''}  ${JSON.stringify(e.data)}`);
        }
        break;
      }

      case 'health': {
        const h = app.health();
        if (has(args, 'json')) console.log(JSON.stringify(h, null, 2));
        else {
          console.log(`${h.ok ? 'OK' : 'DEGRADED'}${h.paused ? ' (PAUSED)' : ''}  ${h.time}  mode: ${h.dryRun ? 'dry-run' : 'LIVE'}  schema v${h.schemaVersion}`);
          console.log(`tasks open: ${h.openTasks}  jobs: ${JSON.stringify(h.jobs)}  notifications queued: ${h.notificationsQueued}  approvals pending: ${h.pendingApprovals}`);
          console.log(`model provider: ${h.modelProvider.name} (${h.modelProvider.live ? 'live' : 'mock'})  channel: ${h.channel.name} (${h.channel.live ? 'live' : 'dry-run'})  calendar: ${h.calendar.connected ? h.calendar.name : 'not connected'}`);
          console.log(`last tick: ${h.lastTickAt ?? 'never'}  quiet hours now: ${app.inQuietHours()}`);
          for (const p of h.problems) console.log(`PROBLEM: ${p}`);
        }
        if (!h.ok) process.exitCode = 1;
        break;
      }

      case 'usage': {
        if (args[0] === 'export') {
          args.shift();
          const format = flag(args, 'format') === 'json' ? 'json' : 'csv';
          const out = flag(args, 'out');
          const data = exportLlmCalls(app.db, format);
          if (out) {
            mkdirSync(dirname(resolve(out)), { recursive: true });
            writeFileSync(out, data);
            console.log(`Wrote ${out}`);
          } else console.log(data);
        } else if (has(args, 'json')) console.log(JSON.stringify(app.usageReport(), null, 2));
        else console.log(formatUsageReport(app.usageReport()));
        break;
      }

      case 'models': {
        if (args[0] !== 'sync') fail('Usage: homepilot models sync');
        const wanted = [...config.models.fast, ...config.models.balanced, ...config.models.premium];
        const prices = await fetchOpenRouterPrices({ baseUrl: config.models.openrouterBaseUrl, nowIso: app.clock.now().toISOString(), only: wanted });
        for (const p of prices) app.prices.upsert(p);
        console.log(`Updated ${prices.length} of ${wanted.length} configured model price(s).`);
        const missing = wanted.filter((m) => !prices.some((p) => p.model === m));
        if (missing.length) console.log(`Not found in the catalog (check the IDs in .env): ${missing.join(', ')}`);
        break;
      }

      case 'prefs': {
        const sub = args.shift();
        if (sub === 'set' && args[0] && args[1] !== undefined) {
          let value: unknown = args.slice(1).join(' ');
          try {
            value = JSON.parse(String(value));
          } catch {
            // keep as plain string
          }
          app.prefs.set(args[0], value, 'user');
          console.log(`Saved ${args[0]}.`);
        } else if (sub === 'delete' && args[0]) {
          console.log(app.prefs.delete(args[0]) ? `Deleted ${args[0]}.` : 'No such preference.');
        } else {
          for (const p of app.prefs.list()) console.log(`${p.key}  [${p.source}]  ${JSON.stringify(p.value)}`);
        }
        break;
      }

      case 'backup': {
        if (config.dbPath === ':memory:') fail('Nothing to back up for an in-memory database.');
        const dir = resolve(args[0] ?? join(dirname(resolve(config.dbPath)), 'backups'));
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `homepilot-${app.clock.now().toISOString().replace(/[:.]/g, '-')}.db`);
        app.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
        console.log(`Backup written to ${file}`);
        break;
      }

      case 'serve': {
        // .env / environment first (validated by config), then the macOS Keychain.
        const token = config.api.token ?? resolveSecret('HOMEPILOT_API_TOKEN');
        if (!token || token.length < 16) {
          fail('Set HOMEPILOT_API_TOKEN (16+ characters) in .env or the Keychain before starting the dashboard.\nGenerate one with: openssl rand -hex 32');
        }
        keepOpen = true;
        const server = createApiServer(app, { token, port: config.api.port });
        await listen(server, config.api.port);
        console.log(`Dashboard: http://127.0.0.1:${config.api.port}/?token=<your HOMEPILOT_API_TOKEN>`);
        console.log('Loopback only. This process does not run the scheduler; use "homepilot run" for that.');
        const stop = (): void => {
          server.close();
          app.close();
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        break;
      }

      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exitCode = 2;
    }
  } finally {
    if (!keepOpen) app.close();
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
