import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ImessageChannel } from '../src/integrations/imessage/channel.js';
import { maskHandle, matchAllowed, normalizeHandle } from '../src/integrations/imessage/handles.js';
import { ImessageListener, type ImsgMessage } from '../src/integrations/imessage/listener.js';
import { ImsgRpc, ImsgRpcError, MAY_HAVE_COMPLETED, type ImsgTransport } from '../src/integrations/imessage/rpc.js';
import { harness, type Harness } from './helpers.js';

const COLE = '+15125550100';

/** In-memory stand-in for `imsg rpc`. Records requests; tests push notifications into it. */
class FakeImsg implements ImsgTransport {
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  private handlers: ((method: string, params: unknown) => void)[] = [];
  dbReady = true;
  sendError: Error | undefined;
  private sub = 0;

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'status') return { version: '0.6.0', database: { ready: this.dbReady } } as T;
    if (method === 'watch.subscribe') return { subscription: ++this.sub, buffer_limit: 256 } as T;
    if (method === 'send') {
      if (this.sendError) throw this.sendError;
      return { ok: true, id: 1, guid: 'GUID-OUT' } as T;
    }
    return {} as T;
  }
  onNotification(h: (method: string, params: unknown) => void): void {
    this.handlers.push(h);
  }
  onExit(): void {}
  close(): void {}
  push(message: Partial<ImsgMessage> & { id: number }): void {
    for (const h of this.handlers) h('message', { subscription: this.sub, message: { chat_id: 7, is_from_me: false, is_group: false, sender: COLE, guid: `G${message.id}`, ...message } });
  }
  overflow(resumeAfter: number): void {
    for (const h of this.handlers) h('watch.overflow', { subscription: this.sub, resume_after_rowid: resumeAfter, reason: 'buffer_limit_exceeded' });
  }
  sends(): { method: string; params: Record<string, unknown> }[] {
    return this.requests.filter((r) => r.method === 'send');
  }
}

describe('handles', () => {
  it('normalizes phone numbers and emails so the same person always matches', () => {
    expect(normalizeHandle('+1 (512) 555-0100')).toBe(COLE);
    expect(normalizeHandle('5125550100')).toBe(COLE);
    expect(normalizeHandle('15125550100')).toBe(COLE);
    expect(normalizeHandle(' Cole@Example.COM ')).toBe('cole@example.com');
    expect(matchAllowed('(512) 555-0100', ['local-cli', '+15125550100'])).toBe('+15125550100');
    expect(matchAllowed('+15125550199', ['local-cli', '+15125550100'])).toBeUndefined();
    expect(matchAllowed('local-cli', ['local-cli'])).toBeUndefined();
    expect(maskHandle('+1 512 555 0100')).toBe('…0100');
    expect(maskHandle('cole@example.com')).toBe('…@example.com');
  });
});

describe('iMessage listener', () => {
  let h: Harness;
  let imsg: FakeImsg;
  let listener: ImessageListener;
  const logs: string[] = [];
  afterEach(() => h?.cleanup());

  async function setup(env: Record<string, string> = {}, file = false): Promise<void> {
    h = harness({ file, env: { HOMEPILOT_ALLOWED_SENDERS: `local-cli,${COLE}`, HOMEPILOT_DRY_RUN: 'false', ...env } });
    imsg = new FakeImsg();
    listener = new ImessageListener(h.app, imsg, { dryRun: h.config.dryRun, maxPerHour: h.config.imessage.maxPerHour, log: (l) => logs.push(l) });
    await listener.start();
  }

  it('turns a text from you into a task and texts the reply back into the same chat', async () => {
    await setup();
    imsg.push({ id: 101, sender: '(512) 555-0100', text: 'remind me to call the dentist tomorrow at 10am' });
    await listener.idle();
    expect(h.app.tasks.list().map((t) => t.title)).toEqual(['Call the dentist']);
    const [send] = imsg.sends();
    expect(send?.params).toEqual({ chat_id: 7, text: expect.stringContaining('Saved "Call the dentist"') });
    expect(h.app.system.get('imessage.cursor')).toBe('101');
  });

  it('ignores its own messages, group chats, edits and empty texts, but still moves the cursor past them', async () => {
    await setup();
    imsg.push({ id: 1, is_from_me: true, text: 'Saved "x"' });
    imsg.push({ id: 2, is_group: true, text: 'remind me to buy milk tomorrow' });
    imsg.push({ id: 3, type: 'edited', text: 'remind me to buy milk tomorrow' });
    imsg.push({ id: 4, text: '   ' });
    await listener.idle();
    expect(h.app.tasks.list()).toHaveLength(0);
    expect(imsg.sends()).toHaveLength(0);
    expect(h.app.system.get('imessage.cursor')).toBe('4');
  });

  it('never answers or acts for a sender who is not on the allowlist, and does not store their text', async () => {
    await setup();
    imsg.push({ id: 5, sender: '+15125550199', text: 'remind me to SECRET-PAYLOAD tomorrow' });
    await listener.idle();
    expect(h.app.tasks.list()).toHaveLength(0);
    expect(imsg.sends()).toHaveLength(0);
    expect(JSON.stringify(h.app.db.all('SELECT * FROM imessage_inbound'))).not.toContain('SECRET-PAYLOAD');
    expect(JSON.stringify(h.app.events.list())).not.toContain('SECRET-PAYLOAD');
    expect(h.app.db.get('SELECT sender, allowed FROM imessage_inbound')).toEqual({ sender: '…0199', allowed: 0 });
  });

  it('handles each message at most once, even when imsg delivers it again', async () => {
    await setup();
    imsg.push({ id: 10, guid: 'SAME', text: 'remind me to water the plants tomorrow' });
    imsg.push({ id: 10, guid: 'SAME', text: 'remind me to water the plants tomorrow' });
    imsg.overflow(9);
    imsg.push({ id: 10, guid: 'SAME', text: 'remind me to water the plants tomorrow' });
    await listener.idle();
    expect(h.app.tasks.list()).toHaveLength(1);
    expect(imsg.sends()).toHaveLength(1);
    // After an overflow it resubscribes from where imsg said to resume.
    expect(imsg.requests.filter((r) => r.method === 'watch.subscribe').map((r) => r.params)).toEqual([{}, { since_rowid: 9 }]);
  });

  it('resumes after a restart from the last message it saw, without replaying history', async () => {
    await setup({}, true);
    expect(imsg.requests.find((r) => r.method === 'watch.subscribe')?.params).toEqual({});
    imsg.push({ id: 200, text: 'tasks' });
    await listener.idle();
    h.restart();
    const again = new FakeImsg();
    await new ImessageListener(h.app, again, { dryRun: false, maxPerHour: 30 }).start();
    expect(again.requests.find((r) => r.method === 'watch.subscribe')?.params).toEqual({ since_rowid: 200 });
  });

  it('in dry-run it acts on your texts but only logs the reply instead of sending it', async () => {
    await setup({ HOMEPILOT_DRY_RUN: 'true' });
    imsg.push({ id: 300, text: 'remind me to feed the cat tonight' });
    await listener.idle();
    expect(h.app.tasks.list()).toHaveLength(1);
    expect(imsg.sends()).toHaveLength(0);
    expect(logs.some((l) => l.includes('(dry-run, not sent) reply to …0100'))).toBe(true);
  });

  it('caps how many texts per hour it will act on, against loops', async () => {
    await setup({ HOMEPILOT_IMESSAGE_MAX_PER_HOUR: '2' });
    for (let i = 1; i <= 4; i++) imsg.push({ id: 400 + i, text: 'tasks' });
    await listener.idle();
    expect(imsg.sends()).toHaveLength(2);
    expect(h.app.events.list({ kind: 'imessage.rate_limited' })).toHaveLength(2);
    h.clock.advanceMinutes(61);
    imsg.push({ id: 410, text: 'tasks' });
    await listener.idle();
    expect(imsg.sends()).toHaveLength(3);
  });

  it('refuses to start, with a clear fix, when it cannot read the Messages database', async () => {
    h = harness();
    imsg = new FakeImsg();
    imsg.dbReady = false;
    await expect(new ImessageListener(h.app, imsg, { dryRun: true, maxPerHour: 30 }).start()).rejects.toThrow(/Full Disk Access/);
  });

  it('does not resend a reply when imsg says the send may already have gone through', async () => {
    await setup();
    imsg.sendError = new ImsgRpcError('delivery may have completed', MAY_HAVE_COMPLETED);
    imsg.push({ id: 500, text: 'tasks' });
    await listener.idle();
    expect(imsg.sends()).toHaveLength(1);
    expect(h.app.events.list({ kind: 'imessage.reply_failed' })).toHaveLength(0);
  });
});

describe('iMessage channel (reminders and nudges)', () => {
  it('texts only the configured handle and returns the message guid', async () => {
    const imsg = new FakeImsg();
    const ch = new ImessageChannel(imsg, COLE);
    expect(await ch.deliver({ idempotencyKey: 'k', body: 'Reminder: x', actions: [] })).toEqual({ providerRef: 'imsg:GUID-OUT' });
    expect(imsg.sends()[0]?.params).toEqual({ to: COLE, text: 'Reminder: x', service: 'imessage' });
  });

  it('treats "may have completed" as sent so the outbox does not text you twice, and rethrows real failures', async () => {
    const imsg = new FakeImsg();
    const ch = new ImessageChannel(imsg, COLE);
    imsg.sendError = new ImsgRpcError('maybe', MAY_HAVE_COMPLETED);
    expect(await ch.deliver({ idempotencyKey: 'k', body: 'b', actions: [] })).toEqual({ providerRef: 'imsg:uncertain' });
    imsg.sendError = new ImsgRpcError('Messages not running', -32603);
    await expect(ch.deliver({ idempotencyKey: 'k2', body: 'b', actions: [] })).rejects.toThrow('Messages not running');
  });

  it('a reminder that fires is texted to you through the outbox exactly once', async () => {
    const imsg = new FakeImsg();
    const h = harness({ env: { HOMEPILOT_DRY_RUN: 'false' }, app: { channel: new ImessageChannel(imsg, COLE) } });
    try {
      await h.say('remind me to call the dentist tomorrow at 10am');
      h.clock.set('2026-11-17T16:00:00.000Z');
      await h.app.tick();
      await h.app.tick();
      expect(imsg.sends()).toHaveLength(1);
      expect(imsg.sends()[0]?.params.text).toContain('Call the dentist');
    } finally {
      h.cleanup();
    }
  });
});

describe('imsg rpc client', () => {
  function fakeChild(): { child: ChildProcessWithoutNullStreams; stdin: PassThrough; stdout: PassThrough } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr }) as unknown as ChildProcessWithoutNullStreams;
    return { child, stdin, stdout };
  }

  it('speaks line-delimited JSON-RPC: matches responses by id, surfaces errors and notifications', async () => {
    const { child, stdin, stdout } = fakeChild();
    const rpc = new ImsgRpc({ cliPath: 'imsg', spawnFn: (cmd, args) => (expect([cmd, ...args]).toEqual(['imsg', 'rpc']), child) });
    const written: string[] = [];
    stdin.on('data', (d: Buffer) => written.push(...d.toString().split('\n').filter(Boolean)));
    const notes: unknown[] = [];
    rpc.onNotification((method, params) => notes.push({ method, params }));

    const a = rpc.request('status');
    const b = rpc.request('send', { to: COLE, text: 'hi' });
    await new Promise((r) => setImmediate(r));
    expect(written.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'status', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'send', params: { to: COLE, text: 'hi' } },
    ]);
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'may have completed' } })}\n`);
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message', params: { subscription: 1, message: { id: 5 } } })}\n`);
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { version: '0.6.0' } })}\n`);
    await expect(a).resolves.toEqual({ version: '0.6.0' });
    await expect(b).rejects.toMatchObject({ code: -32001 });
    expect(notes).toEqual([{ method: 'message', params: { subscription: 1, message: { id: 5 } } }]);
    rpc.close();
  });

  it('fails pending requests and reports when imsg exits', async () => {
    const { child } = fakeChild();
    const rpc = new ImsgRpc({ cliPath: 'imsg', spawnFn: () => child });
    const exits: string[] = [];
    rpc.onExit((r) => exits.push(r));
    const p = rpc.request('status');
    child.emit('exit', 1, null);
    await expect(p).rejects.toThrow('imsg rpc exited (code 1)');
    expect(exits).toEqual(['imsg rpc exited (code 1)']);
    await expect(rpc.request('status')).rejects.toThrow('not running');
  });
});
