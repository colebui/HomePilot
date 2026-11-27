/**
 * Writes one real response from every read route of the local API to a JSON file, so the web
 * dashboard's schemas can be checked against what the service actually sends (a contract test).
 *
 * Runs fully offline: in-memory database, fake clock, mock model, dry-run channel. The texts below
 * are made up; nothing personal is read or written.
 *
 *   npx tsx scripts/api-samples.ts web/tests/fixtures/api-samples.json
 */
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../src/api/server.js';
import { App } from '../src/app.js';
import { FakeClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { MockCalendar } from '../src/integrations/google-calendar/calendar.js';
import { MockProvider } from '../src/models/mock.js';
import { DryRunChannel } from '../src/notify/notifier.js';

const out = process.argv[2] ?? 'web/tests/fixtures/api-samples.json';
const TOKEN = 'sample-token-0123456789abcdef';

async function main(): Promise<void> {
  const clock = new FakeClock('2026-11-16T15:00:00.000Z');
  const app = App.open({
    config: loadConfig({ HOMEPILOT_DB_PATH: ':memory:' }),
    clock,
    channel: new DryRunChannel(),
    calendar: new MockCalendar(),
    provider: new MockProvider(),
  });
  const say = (text: string) => app.handleMessage({ sender: 'local-cli', channel: 'samples', text });

  await say('remind me to call the dentist at 10am');
  await say('remind me to pick up dry cleaning tomorrow at 5pm');
  await say('I need a haircut sometime this week');
  await say('remind me to pay the water bill by friday');
  await say('spent $23.40 at H-E-B');
  await say('paid $45 for gas yesterday');
  await say('xyzzy plugh'); // not understood: exercises the model path with the mock provider
  app.telemetry.recordLlmCall({
    correlationId: 'wf_sample', workflow: 'message', feature: 'intent', taskClass: 'fast', provider: 'openrouter', via: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash-1017', usage: { inputTokens: 1200, outputTokens: 90, cachedTokens: 0 },
    latencyMs: 640, timedOut: false, attempt: 1, isFallback: false, outcome: 'ok', reportedCostUsd: 0.00021,
  });

  clock.set('2026-11-16T16:00:30.000Z');
  await app.tick();
  await say('call the dentist done');
  app.policy.grant('shopping.purchase');
  await app.executor.run({ tool: 'shopping.place_order', input: { retailer: 'heb', totalUsd: 42.5, orderRef: 'CART-1' }, origin: 'user', idempotencyKey: 'sample-order' });

  const probe = createApiServer(app, { token: TOKEN, port: 0 });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createApiServer(app, { token: TOKEN, port });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));

  const routes = ['/api/health', '/api/usage', '/api/agenda', '/api/tasks', '/api/approvals', '/api/insights', '/api/activity', '/api/reminders', '/api/spending'];
  const samples: Record<string, unknown> = {};
  for (const route of routes) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${route}: ${res.status}`);
    samples[route] = await res.json();
  }
  const say2 = await fetch(`http://127.0.0.1:${port}/api/say`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'tasks' }),
  });
  samples['POST /api/say'] = await say2.json();

  await new Promise<void>((r) => server.close(() => r()));
  app.close();
  writeFileSync(out, `${JSON.stringify(samples, null, 2)}\n`);
  console.log(`wrote ${routes.length + 1} samples to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
