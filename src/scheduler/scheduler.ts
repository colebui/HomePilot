import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { newId } from '../ids.js';

export type JobState = 'pending' | 'running' | 'succeeded' | 'dead' | 'cancelled';

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  runAt: Date;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  leaseUntil: Date | null;
  idempotencyKey: string;
  lastError: string | null;
  correlationId: string | null;
}

interface Row {
  id: string;
  type: string;
  payload: string;
  run_at: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  idempotency_key: string;
  last_error: string | null;
  correlation_id: string | null;
}

function fromRow(r: Row): Job {
  return {
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    runAt: new Date(r.run_at),
    state: r.state,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseUntil: r.lease_until ? new Date(r.lease_until) : null,
    idempotencyKey: r.idempotency_key,
    lastError: r.last_error,
    correlationId: r.correlation_id,
  };
}

/**
 * What a handler reports back.
 * - succeeded: the effect happened (or was already in place).
 * - skipped: nothing to do (stale job, task already done). Terminal, not an error.
 * - defer: not now (paused, quiet hours). Re-queued for `until` WITHOUT using up an attempt.
 */
export type JobResult =
  | { outcome: 'succeeded'; detail?: string; llmCalls?: number }
  | { outcome: 'skipped'; detail: string }
  | { outcome: 'defer'; until: Date; detail: string };

export type JobHandler = (job: Job) => Promise<JobResult> | JobResult;

export interface SchedulerOptions {
  /** How long a claimed job may run before another tick may reclaim it (crash recovery). */
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  batchSize?: number;
}

export interface TickSummary {
  recovered: number;
  succeeded: number;
  skipped: number;
  deferred: number;
  failed: number;
  dead: number;
}

/**
 * Durable job scheduler backed by SQLite.
 *
 * Guarantees and limits (read docs/architecture.md before changing):
 * - Jobs live in the database, so they survive process restarts and reboots.
 * - Delivery is AT-LEAST-ONCE: a job whose process died mid-run is re-run after its lease expires.
 *   Handlers must therefore be idempotent. HomePilot's handlers get that from UNIQUE keys in the
 *   outbox and tool-execution tables, not from in-memory state.
 * - Enqueue is idempotent on `idempotencyKey`.
 * - Failures retry with exponential backoff, capped by maxAttempts, then the job is marked "dead".
 * - A single process is assumed. The claim is still a compare-and-set, so a second process is safe.
 */
export class Scheduler {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    opts: SchedulerOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60 * 60_000;
    this.batchSize = opts.batchSize ?? 50;
  }

  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) throw new Error(`Job handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }

  /** Add a job. If a job with the same idempotency key exists, that job is returned unchanged. */
  enqueue(input: {
    type: string;
    payload?: Record<string, unknown>;
    runAt: Date;
    idempotencyKey: string;
    maxAttempts?: number;
    correlationId?: string | null;
  }): { job: Job; created: boolean } {
    const now = this.clock.now().toISOString();
    const id = newId('job');
    const res = this.db.run(
      `INSERT OR IGNORE INTO jobs (id, type, payload, run_at, max_attempts, idempotency_key, correlation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.runAt.toISOString(),
      input.maxAttempts ?? 5,
      input.idempotencyKey,
      input.correlationId ?? null,
      now,
      now,
    );
    const row = this.db.get<Row>('SELECT * FROM jobs WHERE idempotency_key = ?', input.idempotencyKey);
    if (!row) throw new Error('Job vanished after enqueue');
    return { job: fromRow(row), created: res.changes === 1 };
  }

  get(id: string): Job | undefined {
    const r = this.db.get<Row>('SELECT * FROM jobs WHERE id = ?', id);
    return r ? fromRow(r) : undefined;
  }

  getByKey(idempotencyKey: string): Job | undefined {
    const r = this.db.get<Row>('SELECT * FROM jobs WHERE idempotency_key = ?', idempotencyKey);
    return r ? fromRow(r) : undefined;
  }

  list(filter: { states?: JobState[]; limit?: number } = {}): Job[] {
    const states = filter.states ?? ['pending', 'running', 'succeeded', 'dead', 'cancelled'];
    return this.db
      .all<Row>(
        `SELECT * FROM jobs WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY run_at ASC LIMIT ?`,
        ...states,
        filter.limit ?? 200,
      )
      .map(fromRow);
  }

  cancelByKey(idempotencyKey: string): boolean {
    return (
      this.db.run(
        "UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE idempotency_key = ? AND state = 'pending'",
        this.clock.now().toISOString(),
        idempotencyKey,
      ).changes === 1
    );
  }

  private backoff(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempt - 1), this.backoffMaxMs);
  }

  private recordRun(job: Job, attempt: number, startedAt: Date, outcome: string, detail?: string, llmCalls = 0): void {
    this.db.run(
      `INSERT INTO job_runs (job_id, job_type, attempt, started_at, finished_at, outcome, detail, llm_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.type,
      attempt,
      startedAt.toISOString(),
      this.clock.now().toISOString(),
      outcome,
      detail ? detail.slice(0, 500) : null,
      llmCalls,
    );
  }

  /** Return jobs whose worker died (lease expired) to the queue. */
  private recoverExpired(): number {
    const now = this.clock.now();
    const stuck = this.db
      .all<Row>("SELECT * FROM jobs WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?", now.toISOString())
      .map(fromRow);
    for (const job of stuck) {
      const exhausted = job.attempts >= job.maxAttempts;
      this.db.run(
        `UPDATE jobs SET state = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'`,
        exhausted ? 'dead' : 'pending',
        'lease expired (process stopped mid-run)',
        now.toISOString(),
        job.id,
      );
      this.recordRun(job, job.attempts, now, exhausted ? 'dead' : 'recovered', 'lease expired; re-queued for an idempotent re-run');
    }
    return stuck.length;
  }

  /** Run every job that is due now. Safe to call at any frequency and after any downtime. */
  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { recovered: 0, succeeded: 0, skipped: 0, deferred: 0, failed: 0, dead: 0 };
    if (this.ticking) return summary;
    this.ticking = true;
    try {
      summary.recovered = this.recoverExpired();
      const seen = new Set<string>();
      for (;;) {
        const nowIso = this.clock.now().toISOString();
        const due = this.db
          .all<Row>(
            "SELECT * FROM jobs WHERE state = 'pending' AND run_at <= ? ORDER BY run_at ASC, created_at ASC LIMIT ?",
            nowIso,
            this.batchSize,
          )
          .map(fromRow)
          .filter((j) => !seen.has(j.id));
        if (due.length === 0) break;
        for (const job of due) {
          seen.add(job.id); // at most one run per job per tick, so a deferring job cannot spin
          const outcome = await this.runOne(job);
          if (outcome) summary[outcome]++;
        }
      }
      return summary;
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(job: Job): Promise<keyof Omit<TickSummary, 'recovered'> | undefined> {
    const startedAt = this.clock.now();
    const attempt = job.attempts + 1;
    // Compare-and-set claim: only one worker can move a job from pending to running.
    const claimed = this.db.run(
      `UPDATE jobs SET state = 'running', attempts = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
      attempt,
      new Date(startedAt.getTime() + this.leaseMs).toISOString(),
      startedAt.toISOString(),
      job.id,
    );
    if (claimed.changes !== 1) return undefined;

    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      const result = await handler({ ...job, attempts: attempt, state: 'running' });
      const now = this.clock.now().toISOString();
      if (result.outcome === 'defer') {
        // Deferral is not a failure: give the attempt back.
        this.db.run(
          `UPDATE jobs SET state = 'pending', attempts = ?, run_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?`,
          attempt - 1,
          result.until.toISOString(),
          now,
          job.id,
        );
        this.recordRun(job, attempt, startedAt, 'deferred', result.detail);
        return 'deferred';
      }
      this.db.run(
        `UPDATE jobs SET state = 'succeeded', lease_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
        now,
        job.id,
      );
      this.recordRun(
        job,
        attempt,
        startedAt,
        result.outcome,
        result.detail,
        result.outcome === 'succeeded' ? (result.llmCalls ?? 0) : 0,
      );
      return result.outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = this.clock.now();
      const dead = attempt >= job.maxAttempts;
      this.db.run(
        `UPDATE jobs SET state = ?, run_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
        dead ? 'dead' : 'pending',
        dead ? job.runAt.toISOString() : new Date(now.getTime() + this.backoff(attempt)).toISOString(),
        message.slice(0, 500),
        now.toISOString(),
        job.id,
      );
      this.recordRun(job, attempt, startedAt, dead ? 'dead' : 'failed', message);
      return dead ? 'dead' : 'failed';
    }
  }

  /** Start polling on the real clock (daemon mode). Tests call tick() directly instead. */
  start(intervalMs: number, onError: (err: unknown) => void, afterTick?: () => Promise<void>): void {
    if (this.timer) return;
    const loop = async (): Promise<void> => {
      try {
        await this.tick();
        if (afterTick) await afterTick();
      } catch (err) {
        onError(err);
      }
    };
    void loop();
    this.timer = setInterval(() => void loop(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stats(): Record<JobState, number> {
    const out: Record<JobState, number> = { pending: 0, running: 0, succeeded: 0, dead: 0, cancelled: 0 };
    for (const r of this.db.all<{ state: JobState; n: number }>('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state')) {
      out[r.state] = r.n;
    }
    return out;
  }
}
