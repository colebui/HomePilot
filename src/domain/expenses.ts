import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { newId } from '../ids.js';
import { inZone, startOfLocalMonth } from '../time.js';

/**
 * Personal expenses the owner texts in ("spent $23 at H-E-B"). Amounts and merchants only: no bank
 * or card connection, nothing read from anywhere else. Deleting is soft, so "undo" is reversible in
 * the database and the audit trail stays complete.
 */

export const CATEGORIES = ['groceries', 'dining', 'transport', 'shopping', 'bills', 'health', 'entertainment', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Expense {
  id: string;
  /** When the money was spent (not when it was texted). */
  spentAt: Date;
  amountUsd: number;
  merchant: string | null;
  category: Category;
  note: string | null;
  source: string;
  createdAt: Date;
}

interface Row {
  id: string;
  spent_at: string;
  amount_usd: number;
  merchant: string | null;
  category: Category;
  note: string | null;
  source: string;
  created_at: string;
}

const fromRow = (r: Row): Expense => ({
  id: r.id,
  spentAt: new Date(r.spent_at),
  amountUsd: r.amount_usd,
  merchant: r.merchant,
  category: r.category,
  note: r.note,
  source: r.source,
  createdAt: new Date(r.created_at),
});

/** Keyword rules, checked in order against the merchant and note. First match wins. */
const RULES: Array<[Category, RegExp]> = [
  ['groceries', /\b(?:h-?e-?b|grocer(?:y|ies)|kroger|aldi|costco|sam'?s club|trader joe'?s?|whole foods|safeway|publix|wegmans|sprouts|food lion|supermarket)\b/i],
  ['dining', /\b(?:lunch|dinner|breakfast|brunch|coffee|cafe|restaurant|takeout|take-out|chipotle|starbucks|mcdonald'?s|taco|tacos|pizza|burger|sushi|doordash|uber ?eats|grubhub|bar|drinks|boba)\b/i],
  ['transport', /\b(?:gas|fuel|uber|lyft|parking|toll|tolls|shell|exxon|chevron|valero|buc-?ee'?s|bus|train|metro|car wash|oil change)\b/i],
  ['bills', /\b(?:rent|bill|electric|electricity|water|internet|wifi|phone|insurance|utilities|mortgage|subscription)\b/i],
  ['health', /\b(?:pharmacy|cvs|walgreens|doctor|dentist|copay|prescription|meds|medicine|gym|clinic)\b/i],
  ['entertainment', /\b(?:movie|movies|cinema|netflix|spotify|hulu|concert|tickets?|game|games|steam|bowling)\b/i],
  ['shopping', /\b(?:amazon|target|walmart|best buy|clothes|shoes|ikea|home depot|lowe'?s|mall)\b/i],
];

export function categorize(...texts: Array<string | null | undefined>): Category {
  const text = texts.filter(Boolean).join(' ');
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  // "on groceries" / "for dining": the category named outright.
  const named = CATEGORIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  return named ?? 'other';
}

export interface SpendingSummary {
  monthStart: string;
  totalUsd: number;
  count: number;
  byCategory: Array<{ category: Category; totalUsd: number; count: number }>;
  topMerchants: Array<{ merchant: string; totalUsd: number; count: number }>;
  /** Total for the same days of last month (day 1 through today's day number). */
  lastMonthSameDaysUsd: number;
  /** Local YYYY-MM-DD -> total, for every day of this month so far. */
  daily: Array<{ date: string; totalUsd: number }>;
}

export class ExpenseRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  add(e: { amountUsd: number; merchant?: string | null; category?: Category; note?: string | null; spentAt?: Date; source?: string; correlationId?: string | null }): Expense {
    if (!(e.amountUsd > 0) || e.amountUsd >= 1_000_000) throw new Error('amount must be between $0 and $1,000,000');
    const now = this.clock.now().toISOString();
    const id = newId('exp');
    const amount = Math.round(e.amountUsd * 100) / 100;
    this.db.run(
      `INSERT INTO expenses (id, spent_at, amount_usd, merchant, category, note, source, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      (e.spentAt ?? this.clock.now()).toISOString(),
      amount,
      e.merchant ?? null,
      e.category ?? categorize(e.merchant, e.note),
      e.note ?? null,
      e.source ?? 'user',
      e.correlationId ?? null,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Expense | undefined {
    const r = this.db.get<Row>('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL', id);
    return r ? fromRow(r) : undefined;
  }

  list(opts: { since?: Date; limit?: number } = {}): Expense[] {
    return this.db
      .all<Row>(
        'SELECT * FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? ORDER BY spent_at DESC, created_at DESC LIMIT ?',
        (opts.since ?? new Date(0)).toISOString(),
        Math.min(Math.max(opts.limit ?? 100, 1), 1000),
      )
      .map(fromRow);
  }

  /** Soft-delete the most recently texted expense. Returns it, or undefined if there is none. */
  undoLast(): Expense | undefined {
    const r = this.db.get<Row>('SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1');
    if (!r) return undefined;
    this.db.run('UPDATE expenses SET deleted_at = ? WHERE id = ?', this.clock.now().toISOString(), r.id);
    return fromRow(r);
  }

  /** Soft-delete one expense by id. Returns it, or undefined if it does not exist. */
  remove(id: string): Expense | undefined {
    const e = this.get(id);
    if (e) this.db.run('UPDATE expenses SET deleted_at = ? WHERE id = ?', this.clock.now().toISOString(), id);
    return e;
  }

  summary(tz: string): SpendingSummary {
    const now = this.clock.now();
    const local = inZone(now, tz);
    const monthStart = startOfLocalMonth(now, tz);
    const rows = this.list({ since: monthStart, limit: 1000 });
    const byCat = new Map<Category, { totalUsd: number; count: number }>();
    const byMerchant = new Map<string, { merchant: string; totalUsd: number; count: number }>();
    const daily = new Map<string, number>();
    for (let d = local.startOf('month'); d <= local; d = d.plus({ days: 1 })) daily.set(d.toISODate()!, 0);
    for (const e of rows) {
      const c = byCat.get(e.category) ?? { totalUsd: 0, count: 0 };
      c.totalUsd += e.amountUsd;
      c.count += 1;
      byCat.set(e.category, c);
      if (e.merchant) {
        const k = e.merchant.toLowerCase();
        const m = byMerchant.get(k) ?? { merchant: e.merchant, totalUsd: 0, count: 0 };
        m.totalUsd += e.amountUsd;
        m.count += 1;
        byMerchant.set(k, m);
      }
      const day = inZone(e.spentAt, tz).toISODate()!;
      if (daily.has(day)) daily.set(day, daily.get(day)! + e.amountUsd);
    }
    const lastStart = local.startOf('month').minus({ months: 1 });
    const lastEnd = lastStart.plus({ days: local.day });
    const last = this.db.get<{ s: number }>(
      'SELECT COALESCE(SUM(amount_usd), 0) AS s FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at < ?',
      lastStart.toJSDate().toISOString(),
      lastEnd.toJSDate().toISOString(),
    )!.s;
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      monthStart: monthStart.toISOString(),
      totalUsd: round(rows.reduce((s, e) => s + e.amountUsd, 0)),
      count: rows.length,
      byCategory: [...byCat.entries()].map(([category, v]) => ({ category, totalUsd: round(v.totalUsd), count: v.count })).sort((a, b) => b.totalUsd - a.totalUsd),
      topMerchants: [...byMerchant.values()].map((m) => ({ ...m, totalUsd: round(m.totalUsd) })).sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 5),
      lastMonthSameDaysUsd: round(last),
      daily: [...daily.entries()].map(([date, totalUsd]) => ({ date, totalUsd: round(totalUsd) })),
    };
  }
}

export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Plain-text summary for a text reply. */
export function renderSpending(s: SpendingSummary, budgetUsd: number): string {
  if (s.count === 0) return 'No expenses this month yet. Text something like "spent $23 at H-E-B" to log one.';
  const lines = [`This month: ${usd(s.totalUsd)} across ${s.count} expense${s.count === 1 ? '' : 's'}.`];
  if (budgetUsd > 0) lines[0] += ` That's ${Math.round((s.totalUsd / budgetUsd) * 100)}% of your ${usd(budgetUsd)} budget.`;
  for (const c of s.byCategory.slice(0, 4)) lines.push(`${c.category}: ${usd(c.totalUsd)}`);
  if (s.lastMonthSameDaysUsd > 0) lines.push(`Same days last month: ${usd(s.lastMonthSameDaysUsd)}.`);
  return lines.join('\n');
}
