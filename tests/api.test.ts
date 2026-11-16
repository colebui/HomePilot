import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.js';
import { harness, type Harness } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef';
let h: Harness;
let server: Server;
let port: number;
let base: string;

beforeEach(async () => {
  h = harness();
  // Bind an ephemeral loopback port first, then build the real server for that port.
  const probe = createApiServer(h.app, { token: TOKEN, port: 0 });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  server = createApiServer(h.app, { token: TOKEN, port });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  h.cleanup();
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('local dashboard API', () => {
  it('rejects every data route without the token', async () => {
    for (const path of ['/', '/api/health', '/api/usage', '/api/tasks', '/api/outbox', '/api/jobs', '/api/approvals', '/api/events', '/api/export']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(401);
    }
    expect((await fetch(`${base}/api/health`, { headers: { Authorization: 'Bearer wrong-token-000000000000' } })).status).toBe(401);
    expect((await fetch(`${base}/api/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"pause"}' })).status).toBe(401);
    expect(h.app.system.isPaused()).toBe(false);
    // The only open route says nothing useful.
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });

  it('serves data with the token', async () => {
    const health = await (await fetch(`${base}/api/health`, { headers: auth })).json();
    expect(health).toMatchObject({ ok: true, dryRun: true });
    const page = await fetch(`${base}/`, { headers: auth });
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain('<title>HomePilot</title>');
  });

  it('exchanges ?token= for an HttpOnly cookie and drops the token from the URL', async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const ok = await fetch(`${base}/api/health`, { headers: { Cookie: cookie.split(';')[0]! } });
    expect(ok.status).toBe(200);
    expect((await fetch(`${base}/?token=nope-nope-nope-nope`, { redirect: 'manual' })).status).toBe(401);
  });

  it('accepts commands, and blocks cross-site and rebinding requests', async () => {
    const post = (headers: Record<string, string>, body = '{"text":"add buy stamps to my tasks"}') =>
      fetch(`${base}/api/say`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body });

    const ok = await post({});
    expect(await ok.json()).toMatchObject({ authorized: true, reply: 'Saved "Buy stamps".' });
    const tasks = (await (await fetch(`${base}/api/tasks`, { headers: auth })).json()) as { title: string }[];
    expect(tasks.map((t) => t.title)).toEqual(['Buy stamps']);

    expect((await post({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post({}, '{"text":""}')).status).toBe(400);
    expect(h.app.tasks.list()).toHaveLength(1);

    // DNS rebinding: a request that reaches us with someone else's Host header is refused.
    const rebound = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: 'evil.example', ...auth } }, (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      }, reject);
    });
    expect(rebound).toBe(403);
  });

  it('never returns approval arguments, prompts or secrets, and offers a drill-down by workflow', async () => {
    h.app.policy.grant('shopping.purchase');
    await h.app.executor.run({ tool: 'shopping.place_order', input: { retailer: 'heb', totalUsd: 10, orderRef: 'PRIVATE-REF' }, origin: 'user', idempotencyKey: 'k' });
    const approvals = await (await fetch(`${base}/api/approvals`, { headers: auth })).text();
    expect(approvals).not.toContain('"args"');

    h.provider.enqueue({ text: JSON.stringify({ intent: 'list' }) });
    const said = (await (await fetch(`${base}/api/say`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{"text":"erm whats pending"}' })).json()) as { correlationId: string };
    const drill = (await (await fetch(`${base}/api/workflow?id=${said.correlationId}`, { headers: auth })).json()) as { workflow: { workflow: string }; calls: Record<string, unknown>[] };
    expect(drill.workflow.workflow).toBe('message');
    expect(drill.calls).toHaveLength(1);
    expect(JSON.stringify(drill)).not.toContain('erm whats pending');

    const csv = await fetch(`${base}/api/export?format=csv`, { headers: auth });
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(JSON.stringify(await (await fetch(`${base}/api/usage`, { headers: auth })).json())).not.toContain(TOKEN);
  });
});
