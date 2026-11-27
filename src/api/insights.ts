import type { Db } from '../db/database.js';
import { inZone, startOfLocalDay, startOfLocalMonth } from '../time.js';

/**
 * Read-only views for the web dashboard. Nothing here writes, and nothing here returns message
 * text from anyone other than HomePilot itself: task titles and HomePilot's own outgoing texts are
 * the most personal fields that leave this module.
 */

export interface DailySpendPoint {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Provider-reported plus estimated cost. */
  realUsd: number;
  /** Mock-provider cost, never billed. */
  simulatedUsd: number;
  calls: number;
}

export interface LatencyRow {
  model: string;
  calls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Share of calls that did not return usable output (error or invalid output). */
  failureRate: number | null;
}

export interface TextStats {
  /** Texts HomePilot answered this month. */
  handled: number;
  /** Understood by the deterministic parser: no model call, no cost. */
  deterministic: number;
  /** Needed a model to understand. */
  usedModel: number;
  notUnderstood: number;
}

export interface TodaySummary {
  tasksAdded: number;
  tasksCompleted: number;
  remindersSent: number;
  textsHandled: number;
}

export interface Insights {
  generatedAt: string;
  timezone: string;
  today: TodaySummary;
  dailySpend: DailySpendPoint[];
  /** Linear month-end projection from spend so far; null before any real spend this month. */
  projectedMonthUsd: number | null;
  latency: { overall: Omit<LatencyRow, 'model'>; byModel: LatencyRow[] };
  texts: TextStats;
}

export type ActivityKind =
  | 'task_added'
  | 'task_completed'
  | 'task_snoozed'
  | 'task_dismissed'
  | 'reminder_sent'
  | 'nudge_sent'
  | 'text_handled'
  | 'text_not_understood'
  | 'paused'
  | 'resumed'
  | 'budget_alert'
  | 'expense_logged'
  | 'approval'
  | 'problem';

export interface ActivityItem {
  id: string;
  ts: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
}

export interface UpcomingReminder {
  id: string;
  taskId: string;
  title: string;
  fireAt: string;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function latencyRow(rows: { latency_ms: number; outcome: string }[]): Omit<LatencyRow, 'model'> {
  const attempted = rows.filter((r) => r.outcome !== 'blocked_budget');
  const lat = attempted.map((r) => r.latency_ms).sort((a, b) => a - b);
  const failed = attempted.filter((r) => r.outcome === 'error' || r.outcome === 'invalid_output').length;
  return {
    calls: rows.length,
    p50Ms: percentile(lat, 50),
    p95Ms: percentile(lat, 95),
    failureRate: attempted.length ? failed / attempted.length : null,
  };
}

export function buildInsights(db: Db, now: Date, tz: string, opts: { days?: number } = {}): Insights {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 90);
  const todayStart = startOfLocalDay(now, tz).toISOString();
  const monthStartDate = startOfLocalMonth(now, tz);
  const monthStart = monthStartDate.toISOString();
  const firstDay = inZone(now, tz).startOf('day').minus({ days: days - 1 });

  // Daily spend: bucket by local date in JS, since SQLite has no time zone support.
  const buckets = new Map<string, DailySpendPoint>();
  for (let i = 0; i < days; i++) {
    const date = firstDay.plus({ days: i }).toISODate()!;
    buckets.set(date, { date, realUsd: 0, simulatedUsd: 0, calls: 0 });
  }
  const calls = db.all<{ ts: string; cost_usd: number; cost_kind: string }>(
    'SELECT ts, cost_usd, cost_kind FROM llm_calls WHERE ts >= ? ORDER BY ts',
    firstDay.toJSDate().toISOString(),
  );
  for (const c of calls) {
    const b = buckets.get(inZone(new Date(c.ts), tz).toISODate()!);
    if (!b) continue;
    b.calls += 1;
    if (c.cost_kind === 'simulated') b.simulatedUsd += c.cost_usd;
    else if (c.cost_kind === 'provider_reported' || c.cost_kind === 'estimated') b.realUsd += c.cost_usd;
  }

  const monthReal = db.get<{ s: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE ts >= ? AND cost_kind IN ('provider_reported','estimated')",
    monthStart,
  )!.s;
  const local = inZone(now, tz);
  const elapsedDays = Math.max(local.diff(local.startOf('month'), 'days').days, 1 / 24);
  const projectedMonthUsd = monthReal > 0 ? (monthReal / elapsedDays) * local.daysInMonth! : null;

  const latRows = db.all<{ model: string; latency_ms: number; outcome: string }>(
    'SELECT model, latency_ms, outcome FROM llm_calls WHERE ts >= ?',
    monthStart,
  );
  const byModelMap = new Map<string, { latency_ms: number; outcome: string }[]>();
  for (const r of latRows) byModelMap.set(r.model, [...(byModelMap.get(r.model) ?? []), r]);
  const byModel = [...byModelMap.entries()]
    .map(([model, rows]) => ({ model, ...latencyRow(rows) }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));

  const t = db.get<{ handled: number; det: number; model: number; nu: number }>(
    `SELECT COUNT(*) AS handled,
            COALESCE(SUM(succeeded = 1 AND llm_calls = 0), 0) AS det,
            COALESCE(SUM(succeeded = 1 AND llm_calls > 0), 0) AS model,
            COALESCE(SUM(detail = 'not understood'), 0) AS nu
     FROM workflow_runs WHERE workflow = 'message' AND started_at >= ?`,
    monthStart,
  )!;

  const count = (sql: string, ...p: string[]): number => db.get<{ c: number }>(sql, ...p)!.c;
  const today: TodaySummary = {
    tasksAdded: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'task.created' AND ts >= ?", todayStart),
    tasksCompleted: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'task.completed' AND ts >= ?", todayStart),
    remindersSent: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'reminder.fired' AND ts >= ?", todayStart),
    textsHandled: count("SELECT COUNT(*) AS c FROM workflow_runs WHERE workflow = 'message' AND started_at >= ?", todayStart),
  };

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    today,
    dailySpend: [...buckets.values()],
    projectedMonthUsd,
    latency: { overall: latencyRow(latRows), byModel },
    texts: { handled: t.handled, deterministic: t.det, usedModel: t.model, notUnderstood: t.nu },
  };
}

const EVENT_KINDS: Record<string, ActivityKind> = {
  'task.created': 'task_added',
  'task.completed': 'task_completed',
  'task.snoozed': 'task_snoozed',
  'task.dismissed': 'task_dismissed',
  'task.do_not_remind': 'task_dismissed',
  'reminder.fired': 'reminder_sent',
  'system.paused': 'paused',
  'system.resumed': 'resumed',
  'budget.alert': 'budget_alert',
  'expense.logged': 'expense_logged',
  'approval.approved': 'approval',
  'approval.denied': 'approval',
  'imessage.reply_failed': 'problem',
  'imessage.rate_limited': 'problem',
  'message.rejected': 'problem',
};

const COMMAND_LABELS: Record<string, string> = {
  add_task: 'Added a task',
  add_tasks: 'Added several tasks',
  multi: 'Handled several requests',
  list: 'Sent the task list',
  done: 'Marked a task done',
  started: 'Noted a task was started',
  snooze: 'Snoozed a task',
  dismiss: 'Dismissed a task',
  suggest: 'Suggested what to do next',
  status: 'Sent a status report',
  usage: 'Sent a usage report',
  help: 'Sent help',
  approve: 'Approved an action',
  deny: 'Denied an action',
  pause: 'Paused reminders',
  resume: 'Resumed reminders',
};

/** A merged, newest-first feed of what HomePilot did, for people rather than for debugging. */
export function buildActivity(db: Db, opts: { limit?: number } = {}): ActivityItem[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const kinds = Object.keys(EVENT_KINDS);
  const events = db.all<{ id: number; ts: string; kind: string; subject_id: string | null; data: string; title: string | null }>(
    `SELECT e.id, e.ts, e.kind, e.subject_id, e.data,
            COALESCE(t.title, json_extract(e.data, '$.title')) AS title
     FROM events e
     LEFT JOIN tasks t ON t.id = CASE WHEN e.subject_type = 'task' THEN e.subject_id ELSE json_extract(e.data, '$.taskId') END
     WHERE e.kind IN (${kinds.map(() => '?').join(',')})
     ORDER BY e.ts DESC, e.id DESC LIMIT ?`,
    ...kinds,
    limit,
  );
  const items: ActivityItem[] = events.map((e) => {
    const kind = EVENT_KINDS[e.kind]!;
    const data = JSON.parse(e.data) as Record<string, unknown>;
    let title = e.title ?? '';
    let detail: string | null = null;
    switch (e.kind) {
      case 'system.paused':
        title = 'Reminders paused';
        break;
      case 'system.resumed':
        title = 'Reminders resumed';
        break;
      case 'budget.alert':
        title = `Model budget passed ${Math.round(Number(data.threshold ?? 0) * 100)}%`;
        break;
      case 'approval.approved':
      case 'approval.denied':
        title = `${e.kind.endsWith('approved') ? 'Approved' : 'Denied'}: ${String(data.action ?? data.tool ?? 'an action')}`;
        break;
      case 'imessage.reply_failed':
        title = 'A reply could not be sent';
        break;
      case 'imessage.rate_limited':
        title = 'Texts slowed down (rate limit)';
        break;
      case 'message.rejected':
        title = 'Ignored a text from an unknown sender';
        break;
      case 'reminder.fired':
        detail = data.late ? 'Sent late' : null;
        break;
      case 'expense.logged':
        title = `$${Number(data.amountUsd ?? 0).toFixed(2)}${data.merchant ? ` at ${String(data.merchant)}` : ''}`;
        detail = typeof data.category === 'string' ? data.category : null;
        break;
    }
    return { id: `e${e.id}`, ts: e.ts, kind, title: title || 'A task', detail };
  });

  const texts = db.all<{ correlation_id: string; started_at: string; succeeded: number | null; detail: string | null; llm_calls: number }>(
    `SELECT correlation_id, started_at, succeeded, detail, llm_calls FROM workflow_runs
     WHERE workflow = 'message' ORDER BY started_at DESC LIMIT ?`,
    limit,
  );
  for (const w of texts) {
    const understood = w.detail !== 'not understood';
    items.push({
      id: `w${w.correlation_id}`,
      ts: w.started_at,
      kind: understood ? 'text_handled' : 'text_not_understood',
      title: understood ? (COMMAND_LABELS[w.detail ?? ''] ?? 'Answered a text') : "Couldn't read a text",
      detail: w.llm_calls > 0 ? 'Needed a model' : understood ? 'No model needed' : null,
    });
  }

  const nudges = db.all<{ id: string; created_at: string; body: string }>(
    "SELECT id, created_at, body FROM notifications WHERE kind = 'nudge' ORDER BY created_at DESC LIMIT ?",
    limit,
  );
  for (const n of nudges) items.push({ id: `n${n.id}`, ts: n.created_at, kind: 'nudge_sent', title: n.body.split('\n')[0]!.slice(0, 140), detail: null });

  return items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit);
}

export function upcomingReminders(db: Db, opts: { limit?: number } = {}): UpcomingReminder[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return db
    .all<{ id: string; task_id: string; title: string; fire_at: string }>(
      `SELECT r.id, r.task_id, t.title, r.fire_at FROM reminders r JOIN tasks t ON t.id = r.task_id
       WHERE r.state = 'scheduled' AND t.state IN ('open','snoozed') ORDER BY r.fire_at LIMIT ?`,
      limit,
    )
    .map((r) => ({ id: r.id, taskId: r.task_id, title: r.title, fireAt: r.fire_at }));
}
