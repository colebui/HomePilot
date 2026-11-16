import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import type { SystemState } from '../domain/preferences.js';
import { newId } from '../ids.js';

export type NotificationKind = 'reminder' | 'nudge' | 'approval' | 'status' | 'budget';
export type NotificationState = 'queued' | 'sent' | 'failed';

export interface Notification {
  id: string;
  dedupeKey: string;
  channel: string;
  kind: NotificationKind;
  taskId: string | null;
  reminderId: string | null;
  body: string;
  reason: string | null;
  actions: string[];
  state: NotificationState;
  dryRun: boolean;
  createdAt: Date;
  sentAt: Date | null;
  ackAction: string | null;
  ackAt: Date | null;
  correlationId: string | null;
}

interface Row {
  id: string;
  dedupe_key: string;
  channel: string;
  kind: NotificationKind;
  task_id: string | null;
  reminder_id: string | null;
  body: string;
  reason: string | null;
  actions: string;
  state: NotificationState;
  dry_run: number;
  created_at: string;
  sent_at: string | null;
  ack_action: string | null;
  ack_at: string | null;
  correlation_id: string | null;
}

function fromRow(r: Row): Notification {
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    channel: r.channel,
    kind: r.kind,
    taskId: r.task_id,
    reminderId: r.reminder_id,
    body: r.body,
    reason: r.reason,
    actions: JSON.parse(r.actions) as string[],
    state: r.state,
    dryRun: r.dry_run === 1,
    createdAt: new Date(r.created_at),
    sentAt: r.sent_at ? new Date(r.sent_at) : null,
    ackAction: r.ack_action,
    ackAt: r.ack_at ? new Date(r.ack_at) : null,
    correlationId: r.correlation_id,
  };
}

/**
 * A delivery channel (console, iMessage, ...). `idempotencyKey` is the outbox dedupe key:
 * a live channel MUST use it to avoid double-sending when a delivery is retried after a crash.
 */
export interface Channel {
  readonly name: string;
  /** false = mock/dry-run: nothing leaves this machine. */
  readonly live: boolean;
  deliver(message: { idempotencyKey: string; body: string; actions: string[] }): Promise<{ providerRef?: string }>;
}

/** Records messages in memory and delivers nothing. The default in dry-run mode and in tests. */
export class DryRunChannel implements Channel {
  readonly name = 'dry-run';
  readonly live = false;
  readonly delivered: { idempotencyKey: string; body: string; actions: string[] }[] = [];
  private readonly seen = new Set<string>();
  failNext = 0;

  async deliver(message: { idempotencyKey: string; body: string; actions: string[] }): Promise<{ providerRef?: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated channel failure');
    }
    if (!this.seen.has(message.idempotencyKey)) {
      this.seen.add(message.idempotencyKey);
      this.delivered.push(message);
    }
    return { providerRef: `dry-run:${message.idempotencyKey}` };
  }
}

export interface NotifierOptions {
  /** Hard ceiling on deliveries per rolling hour, as a last line of defense against spam. */
  maxPerHour?: number;
  maxDeliveryAttempts?: number;
}

/**
 * Outbox-pattern notifier.
 * enqueue() is a plain INSERT guarded by a UNIQUE dedupe key, so callers can put it in the same
 * transaction as the state change that caused it. dispatchPending() then delivers queued rows.
 */
export class Notifier {
  private readonly maxPerHour: number;
  private readonly maxDeliveryAttempts: number;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly system: SystemState,
    private readonly channel: Channel,
    opts: NotifierOptions = {},
  ) {
    this.maxPerHour = opts.maxPerHour ?? 12;
    this.maxDeliveryAttempts = opts.maxDeliveryAttempts ?? 5;
  }

  get channelName(): string {
    return this.channel.name;
  }

  get channelIsLive(): boolean {
    return this.channel.live;
  }

  enqueue(n: {
    dedupeKey: string;
    kind: NotificationKind;
    body: string;
    reason?: string;
    actions?: string[];
    taskId?: string;
    reminderId?: string;
    correlationId?: string | null;
  }): { notification: Notification; created: boolean } {
    const id = newId('ntf');
    const res = this.db.run(
      `INSERT OR IGNORE INTO notifications
         (id, dedupe_key, channel, kind, task_id, reminder_id, body, reason, actions, dry_run, created_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      n.dedupeKey,
      this.channel.name,
      n.kind,
      n.taskId ?? null,
      n.reminderId ?? null,
      n.body,
      n.reason ?? null,
      JSON.stringify(n.actions ?? []),
      this.channel.live ? 0 : 1,
      this.clock.now().toISOString(),
      n.correlationId ?? null,
    );
    const row = this.db.get<Row>('SELECT * FROM notifications WHERE dedupe_key = ?', n.dedupeKey);
    if (!row) throw new Error('Notification vanished after enqueue');
    return { notification: fromRow(row), created: res.changes === 1 };
  }

  /** Deliver queued notifications. Does nothing while paused; respects the hourly ceiling. */
  async dispatchPending(): Promise<{ sent: number; failed: number; held: number }> {
    const queued = this.db
      .all<Row & { delivery_attempts: number }>("SELECT * FROM notifications WHERE state = 'queued' ORDER BY created_at ASC")
      .map((r) => ({ n: fromRow(r), attempts: r.delivery_attempts }));
    if (queued.length === 0) return { sent: 0, failed: 0, held: 0 };
    if (this.system.isPaused()) return { sent: 0, failed: 0, held: queued.length };

    let sent = 0;
    let failed = 0;
    let held = 0;
    for (const { n, attempts } of queued) {
      const hourAgo = new Date(this.clock.now().getTime() - 3_600_000).toISOString();
      const recent = this.db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM notifications WHERE state = 'sent' AND sent_at > ?",
        hourAgo,
      )!.c;
      if (recent >= this.maxPerHour) {
        held++;
        continue;
      }
      try {
        const res = await this.channel.deliver({ idempotencyKey: n.dedupeKey, body: n.body, actions: n.actions });
        this.db.run(
          "UPDATE notifications SET state = 'sent', sent_at = ?, provider_ref = ?, delivery_attempts = ? WHERE id = ? AND state = 'queued'",
          this.clock.now().toISOString(),
          res.providerRef ?? null,
          attempts + 1,
          n.id,
        );
        sent++;
      } catch {
        const giveUp = attempts + 1 >= this.maxDeliveryAttempts;
        this.db.run(
          'UPDATE notifications SET state = ?, delivery_attempts = ? WHERE id = ?',
          giveUp ? 'failed' : 'queued',
          attempts + 1,
          n.id,
        );
        failed++;
      }
    }
    return { sent, failed, held };
  }

  get(id: string): Notification | undefined {
    const r = this.db.get<Row>('SELECT * FROM notifications WHERE id = ?', id);
    return r ? fromRow(r) : undefined;
  }

  getByDedupeKey(key: string): Notification | undefined {
    const r = this.db.get<Row>('SELECT * FROM notifications WHERE dedupe_key = ?', key);
    return r ? fromRow(r) : undefined;
  }

  list(filter: { kind?: NotificationKind; limit?: number } = {}): Notification[] {
    const rows = filter.kind
      ? this.db.all<Row>('SELECT * FROM notifications WHERE kind = ? ORDER BY created_at DESC LIMIT ?', filter.kind, filter.limit ?? 50)
      : this.db.all<Row>('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', filter.limit ?? 50);
    return rows.map(fromRow);
  }

  /** Most recent notification about a task: what "that" refers to in "snooze that". */
  latestForTaskContext(): Notification | undefined {
    const r = this.db.get<Row>(
      "SELECT * FROM notifications WHERE task_id IS NOT NULL AND kind IN ('reminder','nudge') ORDER BY created_at DESC LIMIT 1",
    );
    return r ? fromRow(r) : undefined;
  }

  countSince(kind: NotificationKind, since: Date): number {
    return this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM notifications WHERE kind = ? AND created_at >= ?',
      kind,
      since.toISOString(),
    )!.c;
  }

  lastCreatedAt(kind: NotificationKind): Date | undefined {
    const r = this.db.get<{ t: string | null }>('SELECT MAX(created_at) AS t FROM notifications WHERE kind = ?', kind);
    return r?.t ? new Date(r.t) : undefined;
  }

  ack(id: string, action: string): boolean {
    return (
      this.db.run(
        'UPDATE notifications SET ack_action = ?, ack_at = ? WHERE id = ?',
        action,
        this.clock.now().toISOString(),
        id,
      ).changes === 1
    );
  }

  ackForTask(taskId: string, action: string): void {
    this.db.run(
      'UPDATE notifications SET ack_action = ?, ack_at = ? WHERE task_id = ? AND ack_action IS NULL',
      action,
      this.clock.now().toISOString(),
      taskId,
    );
  }
}
