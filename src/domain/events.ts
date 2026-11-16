import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';

export interface AuditEvent {
  id: number;
  ts: string;
  correlationId: string | null;
  kind: string;
  actor: string;
  subjectType: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
}

interface Row {
  id: number;
  ts: string;
  correlation_id: string | null;
  kind: string;
  actor: string;
  subject_type: string | null;
  subject_id: string | null;
  data: string;
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|ya29\.[A-Za-z0-9._-]{8,})/g;

/** Redact anything that looks like a credential before it reaches the audit log or a log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Append-only audit trail for every state change and side effect. */
export class EventLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(e: {
    kind: string;
    actor: string;
    correlationId?: string | null;
    subjectType?: string;
    subjectId?: string;
    data?: Record<string, unknown>;
  }): void {
    this.db.run(
      `INSERT INTO events (ts, correlation_id, kind, actor, subject_type, subject_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.clock.now().toISOString(),
      e.correlationId ?? null,
      e.kind,
      e.actor,
      e.subjectType ?? null,
      e.subjectId ?? null,
      JSON.stringify(redact(e.data ?? {})),
    );
  }

  list(filter: { kind?: string; correlationId?: string; limit?: number } = {}): AuditEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.correlationId) {
      where.push('correlation_id = ?');
      params.push(filter.correlationId);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.all<Row>(sql, ...params, filter.limit ?? 200).map((r) => ({
      id: r.id,
      ts: r.ts,
      correlationId: r.correlation_id,
      kind: r.kind,
      actor: r.actor,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }
}
