import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { Db, migrate, openDatabase } from '../src/db/database.js';
import { redact } from '../src/domain/events.js';
import { InvalidTransitionError, TaskNotFoundError } from '../src/domain/tasks.js';
import { actionHash, canonicalJson } from '../src/ids.js';
import { at, harness, MONDAY_9AM, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

describe('config validation', () => {
  it('has safe defaults: offline mock model, dry-run on, Chicago time, approvals required', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ timezone: 'America/Chicago', dryRun: true, allowedSenders: ['local-cli'] });
    expect(c.models.provider).toBe('mock');
    expect(c.policy.tierBMode).toBe('approve');
    expect(c.budget).toMatchObject({ monthlyUsd: 20, alertThresholds: [0.5, 0.8, 1], baselineModel: 'claude-opus-5-5' });
    expect(c.api.token).toBeUndefined();
  });

  it('rejects bad values with a message naming every problem, and never echoes secrets', () => {
    let err: unknown;
    try {
      loadConfig({
        HOMEPILOT_TIMEZONE: 'Mars/Olympus',
        HOMEPILOT_DRY_RUN: 'maybe',
        HOMEPILOT_QUIET_HOURS_START: '25:00',
        HOMEPILOT_MAX_NUDGES_PER_DAY: '-3',
        HOMEPILOT_MODEL_PROVIDER: 'skynet',
        HOMEPILOT_API_TOKEN: 'short',
        OPENROUTER_API_KEY: 'sk-or-v1-SUPERSECRET',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    for (const name of ['HOMEPILOT_TIMEZONE', 'HOMEPILOT_DRY_RUN', 'HOMEPILOT_QUIET_HOURS_START', 'HOMEPILOT_MAX_NUDGES_PER_DAY', 'HOMEPILOT_MODEL_PROVIDER', 'HOMEPILOT_API_TOKEN']) {
      expect(msg).toContain(name);
    }
    expect(msg).not.toContain('SUPERSECRET');
  });

  it('refuses to start in OpenRouter mode without a key, and explains how to fix it', () => {
    // On a Mac the Keychain might legitimately hold one, and so might the developer's shell.
    if (process.platform === 'darwin' || process.env.OPENROUTER_API_KEY) return;
    expect(() => harness({ env: { HOMEPILOT_MODEL_PROVIDER: 'openrouter' }, app: { provider: undefined } })).toThrow(/no OpenRouter key was found/);
  });
});

describe('redaction and hashing', () => {
  it('redacts credential-looking keys and values before they reach the audit log', () => {
    const out = redact({ apiKey: 'abc', nested: { Authorization: 'Bearer abcdefghijkl', note: 'key is sk-or-v1-abcdefgh1234 ok' }, list: ['ya29.abcdefghijk'], fine: 'hello' });
    expect(out).toEqual({ apiKey: '[REDACTED]', nested: { Authorization: '[REDACTED]', note: 'key is [REDACTED] ok' }, list: ['[REDACTED]'], fine: 'hello' });
  });

  it('the audit log applies redaction', () => {
    h = harness();
    h.app.events.record({ kind: 'test', actor: 'test', data: { token: 'secret-value', msg: 'sk-or-v1-abcdefgh1234' } });
    const stored = JSON.stringify(h.app.events.list({ kind: 'test' }));
    expect(stored).not.toContain('secret-value');
    expect(stored).not.toContain('sk-or-v1');
  });

  it('action hashes ignore key order and change with any argument', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(actionHash('t', { a: 1, b: 2 })).toBe(actionHash('t', { b: 2, a: 1 }));
    expect(actionHash('t', { a: 1, b: 2 })).not.toBe(actionHash('t', { a: 1, b: 3 }));
    expect(actionHash('t', { a: 1 })).not.toBe(actionHash('u', { a: 1 }));
  });
});

describe('database', () => {
  it('migrations are idempotent and create every Phase 1 table', () => {
    const db = openDatabase(':memory:', MONDAY_9AM);
    expect(migrate(db, MONDAY_9AM)).toEqual([]);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    for (const t of ['tasks', 'reminders', 'preferences', 'events', 'approvals', 'tool_executions', 'jobs', 'job_runs', 'notifications', 'llm_calls', 'workflow_runs', 'other_costs', 'model_prices', 'system_state', 'schema_migrations']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('transactions roll back fully, including nested ones', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    expect(() =>
      db.tx(() => {
        db.run('INSERT INTO t VALUES (1)');
        db.tx(() => db.run('INSERT INTO t VALUES (2)'));
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')!.n).toBe(0);

    db.tx(() => {
      db.run('INSERT INTO t VALUES (1)');
      try {
        db.tx(() => {
          db.run('INSERT INTO t VALUES (2)');
          throw new Error('inner');
        });
      } catch {
        // inner savepoint rolled back; outer continues
      }
    });
    expect(db.all<{ v: number }>('SELECT v FROM t').map((r) => r.v)).toEqual([1]);
    db.close();
  });

  it('a failed reminder insert does not leave an orphan task behind', () => {
    h = harness();
    expect(() => h.app.addTask({ title: 'x' }, { remindAt: new Date(NaN) })).toThrow();
    expect(h.app.tasks.list()).toHaveLength(0);
  });
});

describe('tasks', () => {
  it('supports create, read, update, list ordering and delete', () => {
    h = harness();
    const a = h.app.tasks.create({ title: '  Later thing  ', dueAt: at('2026-11-25T15:00:00.000Z') });
    const b = h.app.tasks.create({ title: 'Sooner thing', dueAt: at('2026-11-18T15:00:00.000Z'), priority: 4, estimatedMinutes: 20, dependsOn: [a.id], location: 'Post office', energy: 'low' });
    const c = h.app.tasks.create({ title: 'No date' });
    expect(a.title).toBe('Later thing');
    expect(b).toMatchObject({ priority: 4, estimatedMinutes: 20, dependsOn: [a.id], location: 'Post office', energy: 'low', state: 'open', notificationCount: 0 });
    expect(h.app.tasks.list().map((t) => t.id)).toEqual([b.id, a.id, c.id]);

    const updated = h.app.tasks.update(c.id, { title: 'Now dated', dueAt: at('2026-11-17T15:00:00.000Z'), priority: 3 });
    expect(updated).toMatchObject({ title: 'Now dated', priority: 3 });
    expect(h.app.tasks.update(c.id, { dueAt: null }).dueAt).toBeNull();
    expect(h.app.tasks.delete(c.id)).toBe(true);
    expect(h.app.tasks.get(c.id)).toBeUndefined();
  });

  it('validates input', () => {
    h = harness();
    expect(() => h.app.tasks.create({ title: '   ' })).toThrow();
    expect(() => h.app.tasks.create({ title: 'x', priority: 9 })).toThrow();
    expect(() => h.app.tasks.create({ title: 'x', windowStart: at('2026-11-20T00:00:00Z'), windowEnd: at('2026-11-19T00:00:00Z') })).toThrow(/window ends before it starts/);
    expect(() => h.app.tasks.require('task_missing')).toThrow(TaskNotFoundError);
  });

  it('enforces state transitions', () => {
    h = harness();
    const t = h.app.tasks.create({ title: 'x' });
    expect(() => h.app.tasks.snooze(t.id, at('2026-11-16T14:00:00.000Z'))).toThrow(/must be in the future/);
    h.app.tasks.snooze(t.id, at('2026-11-16T18:00:00.000Z'));
    h.app.tasks.complete(t.id);
    expect(h.app.tasks.get(t.id)).toMatchObject({ state: 'done', snoozeUntil: null });
    expect(h.app.tasks.get(t.id)!.completedAt!.toISOString()).toBe(MONDAY_9AM);
    expect(() => h.app.tasks.snooze(t.id, at('2026-11-16T18:00:00.000Z'))).toThrow(InvalidTransitionError);
    expect(() => h.app.tasks.dismiss(t.id)).toThrow(InvalidTransitionError);
    expect(h.app.tasks.reopen(t.id)).toMatchObject({ state: 'open', completedAt: null });
  });

  it('wakes snoozed tasks only once their time has come', () => {
    h = harness();
    const t = h.app.tasks.create({ title: 'x' });
    h.app.tasks.snooze(t.id, at('2026-11-16T18:00:00.000Z'));
    h.clock.set('2026-11-16T17:59:59.000Z');
    expect(h.app.tasks.wakeDueSnoozes()).toBe(0);
    h.clock.set('2026-11-16T18:00:00.000Z');
    expect(h.app.tasks.wakeDueSnoozes()).toBe(1);
    expect(h.app.tasks.get(t.id)!.state).toBe('open');
  });
});

describe('preferences and memory', () => {
  it('can be viewed, corrected, exported and deleted; seeded guesses are marked and never overwrite edits', () => {
    h = harness({ file: true });
    const seeded = h.app.prefs.list().find((p) => p.key === 'travel.interests')!;
    expect(seeded.source).toBe('hypothesis');
    h.app.prefs.set('travel.interests', ['live music'], 'user');
    h.app.prefs.set('home.airport', 'AUS');
    const app = h.restart(); // seeding runs again on open and must not clobber the edit
    expect(app.prefs.get('travel.interests')).toEqual(['live music']);
    expect(app.prefs.list().find((p) => p.key === 'travel.interests')!.source).toBe('user');
    expect(JSON.parse(JSON.stringify(app.prefs.list())).length).toBe(2);
    expect(app.prefs.delete('home.airport')).toBe(true);
    expect(app.prefs.get('home.airport')).toBeUndefined();
  });
});

describe('health', () => {
  it('reports degraded state for dead jobs and an idle scheduler', async () => {
    h = harness();
    expect(h.app.health()).toMatchObject({ ok: true, paused: false, dryRun: true, schemaVersion: 1, problems: [] });
    h.app.scheduler.enqueue({ type: 'no.such.handler', runAt: new FakeClock(MONDAY_9AM).now(), idempotencyKey: 'x', maxAttempts: 1 });
    h.clock.advanceMinutes(11);
    expect(h.app.health().problems.join(' ')).toMatch(/more than 10 minutes overdue/);
    await h.app.tick();
    const health = h.app.health();
    expect(health.ok).toBe(false);
    expect(health.problems.join(' ')).toMatch(/1 job\(s\) failed permanently/);
    expect(health.modelProvider).toEqual({ name: 'mock', live: false });
    expect(health.channel).toEqual({ name: 'dry-run', live: false });
  });
});
