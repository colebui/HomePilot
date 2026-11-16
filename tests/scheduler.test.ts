import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { openDatabase } from '../src/db/database.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { MONDAY_9AM } from './helpers.js';

function setup(opts = {}) {
  const clock = new FakeClock(MONDAY_9AM);
  const db = openDatabase(':memory:', clock.now().toISOString());
  const scheduler = new Scheduler(db, clock, { leaseMs: 60_000, backoffBaseMs: 30_000, ...opts });
  return { clock, db, scheduler };
}
const inMin = (clock: FakeClock, m: number): Date => new Date(clock.now().getTime() + m * 60_000);

describe('Scheduler', () => {
  it('runs a job only once it is due, and only once', async () => {
    const { clock, scheduler } = setup();
    let runs = 0;
    scheduler.register('t', () => {
      runs++;
      return { outcome: 'succeeded' };
    });
    scheduler.enqueue({ type: 't', runAt: inMin(clock, 10), idempotencyKey: 'a' });

    await scheduler.tick();
    expect(runs).toBe(0);
    clock.advanceMinutes(9);
    await scheduler.tick();
    expect(runs).toBe(0);
    clock.advanceMinutes(1);
    await scheduler.tick();
    await scheduler.tick();
    clock.advanceMinutes(600);
    await scheduler.tick();
    expect(runs).toBe(1);
    expect(scheduler.stats().succeeded).toBe(1);
  });

  it('enqueue is idempotent on the idempotency key', () => {
    const { clock, scheduler } = setup();
    const a = scheduler.enqueue({ type: 't', runAt: inMin(clock, 1), idempotencyKey: 'same' });
    const b = scheduler.enqueue({ type: 't', runAt: inMin(clock, 99), idempotencyKey: 'same' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(scheduler.stats().pending).toBe(1);
  });

  it('retries failures with exponential backoff, then marks the job dead', async () => {
    const { clock, db, scheduler } = setup();
    let runs = 0;
    scheduler.register('flaky', () => {
      runs++;
      throw new Error('boom');
    });
    const { job } = scheduler.enqueue({ type: 'flaky', runAt: clock.now(), idempotencyKey: 'f', maxAttempts: 3 });

    await scheduler.tick(); // attempt 1 fails -> retry in 30s
    expect(runs).toBe(1);
    await scheduler.tick();
    expect(runs).toBe(1); // not yet due again
    clock.advance(29_000);
    await scheduler.tick();
    expect(runs).toBe(1);
    clock.advance(1_000);
    await scheduler.tick(); // attempt 2 fails -> retry in 60s
    expect(runs).toBe(2);
    clock.advance(59_000);
    await scheduler.tick();
    expect(runs).toBe(2);
    clock.advance(1_000);
    const last = await scheduler.tick(); // attempt 3 fails -> dead
    expect(runs).toBe(3);
    expect(last.dead).toBe(1);
    expect(scheduler.get(job.id)!.state).toBe('dead');
    expect(scheduler.get(job.id)!.lastError).toBe('boom');

    clock.advanceMinutes(600);
    await scheduler.tick();
    expect(runs).toBe(3); // bounded: never retried again
    const outcomes = db.all<{ outcome: string }>('SELECT outcome FROM job_runs ORDER BY id').map((r) => r.outcome);
    expect(outcomes).toEqual(['failed', 'failed', 'dead']);
  });

  it('succeeds on a later attempt after a transient failure', async () => {
    const { clock, scheduler } = setup();
    let runs = 0;
    scheduler.register('t', () => {
      runs++;
      if (runs === 1) throw new Error('transient');
      return { outcome: 'succeeded' };
    });
    const { job } = scheduler.enqueue({ type: 't', runAt: clock.now(), idempotencyKey: 'x' });
    await scheduler.tick();
    clock.advance(30_000);
    await scheduler.tick();
    expect(scheduler.get(job.id)!.state).toBe('succeeded');
    expect(scheduler.get(job.id)!.attempts).toBe(2);
  });

  it('recovers a job whose process died mid-run once the lease expires', async () => {
    const { clock, db, scheduler } = setup();
    let runs = 0;
    scheduler.register('t', () => {
      runs++;
      return { outcome: 'succeeded' };
    });
    const { job } = scheduler.enqueue({ type: 't', runAt: clock.now(), idempotencyKey: 'crash' });
    // Simulate a crash: the job was claimed (running, attempt 1) and then the process vanished.
    db.run("UPDATE jobs SET state = 'running', attempts = 1, lease_until = ? WHERE id = ?", new Date(clock.now().getTime() + 60_000).toISOString(), job.id);

    await scheduler.tick();
    expect(runs).toBe(0); // lease still held: do not double-run a job that may be alive
    clock.advance(60_000);
    const t = await scheduler.tick();
    expect(t.recovered).toBe(1);
    expect(runs).toBe(1);
    expect(scheduler.get(job.id)!.state).toBe('succeeded');
    expect(scheduler.get(job.id)!.attempts).toBe(2);
  });

  it('a deferral re-queues the job without consuming an attempt', async () => {
    const { clock, scheduler } = setup();
    let allow = false;
    scheduler.register('t', () =>
      allow ? { outcome: 'succeeded' } : { outcome: 'defer', until: inMin(clock, 5), detail: 'paused' },
    );
    const { job } = scheduler.enqueue({ type: 't', runAt: clock.now(), idempotencyKey: 'd', maxAttempts: 1 });
    for (let i = 0; i < 4; i++) {
      const t = await scheduler.tick();
      expect(t.deferred).toBe(1);
      expect(scheduler.get(job.id)!.attempts).toBe(0);
      clock.advanceMinutes(5);
    }
    allow = true;
    await scheduler.tick();
    expect(scheduler.get(job.id)!.state).toBe('succeeded');
  });

  it('a job with no handler fails loudly instead of disappearing', async () => {
    const { clock, scheduler } = setup();
    const { job } = scheduler.enqueue({ type: 'nobody', runAt: clock.now(), idempotencyKey: 'n', maxAttempts: 1 });
    await scheduler.tick();
    expect(scheduler.get(job.id)!.state).toBe('dead');
    expect(scheduler.get(job.id)!.lastError).toMatch(/No handler/);
  });

  it('cancels a pending job by key', async () => {
    const { clock, scheduler } = setup();
    let runs = 0;
    scheduler.register('t', () => {
      runs++;
      return { outcome: 'succeeded' };
    });
    scheduler.enqueue({ type: 't', runAt: inMin(clock, 1), idempotencyKey: 'c' });
    expect(scheduler.cancelByKey('c')).toBe(true);
    clock.advanceMinutes(5);
    await scheduler.tick();
    expect(runs).toBe(0);
  });
});
