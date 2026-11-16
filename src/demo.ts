import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app.js';
import { FakeClock } from './clock.js';
import { loadConfig } from './config.js';
import { MockCalendar } from './integrations/google-calendar/calendar.js';
import { MockProvider } from './models/mock.js';
import { DryRunChannel } from './notify/notifier.js';
import { formatUsageReport } from './telemetry/report.js';
import { formatLocal } from './time.js';

/**
 * End-to-end DRY-RUN demonstration on a throwaway database with a fake clock.
 * Nothing here is real: no messages are sent, no model is called, no money is spent, and the
 * calendar is an in-memory mock. It exists to show the Phase 1 flow working from start to finish:
 *   create task -> save -> schedule -> (restart) -> trigger -> mock notification -> snooze -> done
 */
export async function runDemo(log: (line: string) => void = console.log): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'homepilot-demo-'));
  const dbPath = join(dir, 'demo.db');
  const config = loadConfig({ HOMEPILOT_DB_PATH: dbPath, HOMEPILOT_TIMEZONE: 'America/Chicago', HOMEPILOT_MONTHLY_BUDGET_USD: '5' });
  const tz = config.timezone;

  // Monday 2026-11-16, 9:00 AM in Chicago (CST, UTC-6).
  const clock = new FakeClock('2026-11-16T15:00:00.000Z');
  const channel = new DryRunChannel();
  const calendar = new MockCalendar();
  const provider = new MockProvider();
  const open = (): App => App.open({ config, clock, channel, calendar, provider });
  let app = open();

  const step = (title: string): void => log(`\n=== ${title} ===`);
  const now = (): string => formatLocal(clock.now(), tz);
  const say = async (text: string): Promise<void> => {
    const r = await app.handleMessage({ sender: 'local-cli', channel: 'demo', text });
    log(`  you: ${text}`);
    log(`  homepilot [${r.understoodBy}]: ${r.reply}`);
  };
  const tick = async (): Promise<void> => {
    const t = await app.tick();
    log(`  tick @ ${now()}: jobs ${JSON.stringify(t.jobs)}, notifications ${JSON.stringify(t.notifications)}`);
  };
  const outbox = (): void => {
    log(`  outbox now holds ${channel.delivered.length} delivered message(s):`);
    for (const m of channel.delivered) log(`    - ${m.body}`);
  };

  try {
    log('HomePilot dry-run demo. Everything below is SIMULATED on a temporary database.');
    log(`Fake clock starts at ${now()}.`);

    step('1. Create tasks from plain text (deterministic parser, no model)');
    await say('Remind me to return that Amazon package before Friday');
    await say('I need a haircut sometime this week');
    await say('tasks');
    log(`  jobs waiting: ${app.scheduler.stats().pending}`);

    step('2. Simulated restart: close the database and open it again');
    app.close();
    app = open();
    app.ensureNudgeLoop();
    log(`  after restart: ${app.tasks.list().length} tasks, ${app.scheduler.stats().pending} job(s) still waiting`);

    step('3. Nothing fires early');
    clock.set('2026-11-18T15:00:00.000Z'); // Wed 9:00 AM
    calendar.setEvents([{ start: new Date('2026-11-18T14:00:00.000Z'), end: new Date('2026-11-18T23:00:00.000Z') }]); // busy all day
    await tick();
    outbox();

    step("4. The reminder fires once at its due time (Thu 9:00 AM, the morning of the last day)");
    clock.set('2026-11-19T15:00:00.000Z');
    calendar.setEvents([{ start: new Date('2026-11-19T14:00:00.000Z'), end: new Date('2026-11-19T23:00:00.000Z') }]);
    await tick();
    await tick(); // a second tick must not send it again
    outbox();

    step('5. Snooze it, then it fires once more at the snoozed time');
    await say('snooze that until tomorrow 8am');
    clock.set('2026-11-20T14:00:00.000Z'); // Fri 8:00 AM
    calendar.setEvents([{ start: new Date('2026-11-20T14:00:00.000Z'), end: new Date('2026-11-20T23:00:00.000Z') }]);
    await tick();
    outbox();

    step('6. Acknowledge: mark it done');
    await say('done with the return');

    step('7. Calendar-aware nudge (mock calendar: free until 1:00 PM on Saturday)');
    clock.set('2026-11-21T16:00:00.000Z'); // Sat 10:00 AM
    calendar.setEvents([{ start: new Date('2026-11-21T19:00:00.000Z'), end: new Date('2026-11-21T20:00:00.000Z') }]);
    await tick();
    outbox();
    await say('what should I do with my free hour?');

    step('8. A message the parser does not know goes to a small model (MOCK model here)');
    provider.enqueue({ text: JSON.stringify({ intent: 'add_task', title: 'Clean the gutters', when_text: 'next week' }) });
    await say('could you jot down that the gutters want cleaning next week');

    step('9. Approvals: a purchase (tier C) needs its exact code; a casual "yes" is not enough');
    app.policy.grant('shopping.purchase');
    const order = { retailer: 'heb', totalUsd: 42.5, orderRef: 'DEMO-CART-1' };
    const first = await app.executor.run({ tool: 'shopping.place_order', input: order, origin: 'user', idempotencyKey: 'demo-order-1' });
    log(`  proposed order -> ${first.status}`);
    await app.tick();
    log(`  prompt sent: ${channel.delivered[channel.delivered.length - 1]?.body}`);
    await say('yes');
    const code = first.status === 'awaiting_approval' ? first.approval.code : '';
    await say(`approve ${code}`);
    const again = await app.executor.run({ tool: 'shopping.place_order', input: order, origin: 'user', idempotencyKey: 'demo-order-1' });
    log(`  same request again -> ${again.status}${again.status === 'succeeded' ? ` (replayed: ${again.replayed}, mode: ${again.mode})` : ''}`);

    step('10. Prompt injection: text inside a web page cannot trigger a tool');
    const injected = await app.executor.run({
      tool: 'shopping.place_order',
      input: { retailer: 'amazon', totalUsd: 999, orderRef: 'INJECTED' },
      origin: 'untrusted_content',
      idempotencyKey: 'demo-injected-1',
    });
    log(`  tool call proposed by web content -> ${injected.status}${injected.status === 'denied' ? `: ${injected.reason}` : ''}`);

    step('11. Kill switch');
    await say('pause');
    const paused = await app.executor.run({ tool: 'tasks.create', input: { title: 'should not happen' }, origin: 'user', idempotencyKey: 'demo-paused-1' });
    log(`  tool call while paused -> ${paused.status}`);
    await say('resume');

    step('12. Usage report (DEMONSTRATION DATA: mock model, simulated cost, never billed)');
    log(formatUsageReport(app.usageReport()));

    step('13. Health');
    log(JSON.stringify(app.health(), null, 2));
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
