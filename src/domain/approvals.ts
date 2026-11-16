import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { actionHash, canonicalJson, newId, shortCode } from '../ids.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export interface Approval {
  id: string;
  /** Short code the user types back, so a reply binds to exactly this request. */
  code: string;
  tool: string;
  tier: 'B' | 'C';
  actionHash: string;
  /** Exact proposed action, in plain words. */
  action: string;
  target: string | null;
  priceUsd: number | null;
  args: unknown;
  state: ApprovalState;
  idempotencyKey: string;
  correlationId: string | null;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  consumedAt: Date | null;
}

interface Row {
  id: string;
  code: string;
  tool: string;
  tier: 'B' | 'C';
  action_hash: string;
  action: string;
  target: string | null;
  price_usd: number | null;
  args: string;
  state: ApprovalState;
  idempotency_key: string;
  correlation_id: string | null;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  consumed_at: string | null;
}

function fromRow(r: Row): Approval {
  return {
    id: r.id,
    code: r.code,
    tool: r.tool,
    tier: r.tier,
    actionHash: r.action_hash,
    action: r.action,
    target: r.target,
    priceUsd: r.price_usd,
    args: JSON.parse(r.args) as unknown,
    state: r.state,
    idempotencyKey: r.idempotency_key,
    correlationId: r.correlation_id,
    requestedAt: new Date(r.requested_at),
    expiresAt: new Date(r.expires_at),
    decidedAt: r.decided_at ? new Date(r.decided_at) : null,
    decidedBy: r.decided_by,
    consumedAt: r.consumed_at ? new Date(r.consumed_at) : null,
  };
}

/**
 * Approval records. An approval authorizes ONE exact action (tool + arguments, bound by hash),
 * for a limited time, and can be used once. Nothing in here is decided by a model.
 */
export class ApprovalStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Create a pending approval, or return the existing one for the same idempotency key. */
  request(input: {
    tool: string;
    tier: 'B' | 'C';
    args: unknown;
    action: string;
    target?: string;
    priceUsd?: number;
    idempotencyKey: string;
    correlationId?: string | null;
    ttlMinutes: number;
  }): { approval: Approval; created: boolean } {
    this.expireDue();
    const now = this.clock.now();
    const id = newId('apr');
    const res = this.db.run(
      `INSERT OR IGNORE INTO approvals (id, code, tool, tier, action_hash, action, target, price_usd, args,
         idempotency_key, correlation_id, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.freshCode(),
      input.tool,
      input.tier,
      actionHash(input.tool, input.args),
      input.action,
      input.target ?? null,
      input.priceUsd ?? null,
      canonicalJson(input.args),
      input.idempotencyKey,
      input.correlationId ?? null,
      now.toISOString(),
      new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString(),
    );
    const row = this.db.get<Row>('SELECT * FROM approvals WHERE idempotency_key = ?', input.idempotencyKey);
    if (!row) throw new Error('Approval vanished after insert');
    return { approval: fromRow(row), created: res.changes === 1 };
  }

  private freshCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = shortCode();
      const clash = this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM approvals WHERE code = ? AND state IN ('pending','approved')",
        code,
      )!.n;
      if (clash === 0) return code;
    }
    throw new Error('Could not allocate an approval code');
  }

  get(id: string): Approval | undefined {
    this.expireDue();
    const r = this.db.get<Row>('SELECT * FROM approvals WHERE id = ?', id);
    return r ? fromRow(r) : undefined;
  }

  getByKey(idempotencyKey: string): Approval | undefined {
    this.expireDue();
    const r = this.db.get<Row>('SELECT * FROM approvals WHERE idempotency_key = ?', idempotencyKey);
    return r ? fromRow(r) : undefined;
  }

  /** Find the pending approval a typed code refers to. */
  getPendingByCode(code: string): Approval | undefined {
    this.expireDue();
    const r = this.db.get<Row>(
      "SELECT * FROM approvals WHERE code = ? AND state = 'pending' ORDER BY requested_at DESC LIMIT 1",
      code.trim().toUpperCase(),
    );
    return r ? fromRow(r) : undefined;
  }

  listPending(): Approval[] {
    this.expireDue();
    return this.db.all<Row>("SELECT * FROM approvals WHERE state = 'pending' ORDER BY requested_at ASC").map(fromRow);
  }

  list(limit = 50): Approval[] {
    this.expireDue();
    return this.db.all<Row>('SELECT * FROM approvals ORDER BY requested_at DESC LIMIT ?', limit).map(fromRow);
  }

  /** Pending or approved-but-unused approvals lapse at their expiry time. */
  expireDue(): number {
    const now = this.clock.now().toISOString();
    return this.db.run(
      "UPDATE approvals SET state = 'expired' WHERE state IN ('pending','approved') AND expires_at <= ?",
      now,
    ).changes;
  }

  /** Record the user's decision. Only a still-pending, unexpired approval can be decided. */
  decide(id: string, decision: 'approved' | 'denied', actor: string): Approval | undefined {
    this.expireDue();
    const now = this.clock.now().toISOString();
    const res = this.db.run(
      "UPDATE approvals SET state = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'",
      decision,
      now,
      actor,
      id,
    );
    return res.changes === 1 ? this.get(id) : undefined;
  }

  /**
   * Atomically spend an approval for one exact action. Fails (returns false) unless the approval
   * is approved, unexpired, unused and its hash matches the action about to run.
   */
  consume(id: string, hash: string): boolean {
    const now = this.clock.now().toISOString();
    return (
      this.db.run(
        `UPDATE approvals SET state = 'consumed', consumed_at = ?
         WHERE id = ? AND state = 'approved' AND action_hash = ? AND expires_at > ?`,
        now,
        id,
        hash,
        now,
      ).changes === 1
    );
  }
}
