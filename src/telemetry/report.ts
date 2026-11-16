import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { ASSUMED_CACHE_READ_FRACTION, CLAUDE_API_PRICES, CLAUDE_API_PRICES_DATE, type PriceBook } from '../models/pricing.js';
import { inZone, startOfLocalDay, startOfLocalMonth } from '../time.js';

export interface SpendSplit {
  /** Charges the provider itself reported. The closest thing to an invoice we have. */
  providerReportedUsd: number;
  /** Computed by HomePilot from token counts and a price table. Not an invoice. */
  estimatedUsd: number;
  /** Mock-provider calls. Never billed. Shown only so demos have numbers. */
  simulatedUsd: number;
}

export interface GroupRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  realCostUsd: number;
  simulatedCostUsd: number;
}

export interface UsageReport {
  generatedAt: string;
  timezone: string;
  containsSimulatedData: boolean;
  spend: { today: SpendSplit; last7Days: SpendSplit; thisMonth: SpendSplit };
  byModel: GroupRow[];
  byFeature: GroupRow[];
  calls: {
    total: number;
    ok: number;
    invalidOutput: number;
    errors: number;
    blockedByBudget: number;
    timeouts: number;
    retries: number;
    fallbacks: number;
    avgLatencyMs: number | null;
  };
  workflows: {
    total: number;
    succeeded: number;
    failed: number;
    unfinished: number;
    failureRate: number | null;
    deterministic: number;
    usedModel: number;
    /** Real (non-simulated) model spend this month divided by successful workflows this month. */
    costPerSuccessfulWorkflowUsd: number | null;
  };
  baseline: {
    model: string;
    priceDate: string;
    /** Covers the same calls as actualUsd. */
    hypotheticalClaudeOnlyUsd: number;
    actualUsd: number;
    differenceUsd: number;
    differencePct: number | null;
    basis: 'real calls this month' | 'simulated calls this month (demo only)' | 'no calls yet';
    caveats: string[];
  };
  budget: { monthlyUsd: number; usedUsd: number; usedFraction: number | null; thresholds: { at: number; crossed: boolean }[] };
  otherCosts: { category: string; amountUsd: number; costKind: string }[];
  priceAssumptions: { model: string; inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number | null; source: string; asOf: string }[];
}

const KINDS = `
  COALESCE(SUM(CASE WHEN cost_kind = 'provider_reported' THEN cost_usd END), 0) AS reported,
  COALESCE(SUM(CASE WHEN cost_kind = 'estimated' THEN cost_usd END), 0) AS estimated,
  COALESCE(SUM(CASE WHEN cost_kind = 'simulated' THEN cost_usd END), 0) AS simulated`;

export function buildUsageReport(deps: {
  db: Db;
  clock: Clock;
  prices: PriceBook;
  timezone: string;
  baselineModel: string;
  monthlyBudgetUsd: number;
  alertThresholds: number[];
}): UsageReport {
  const { db, clock, timezone } = deps;
  const now = clock.now();
  const dayStart = startOfLocalDay(now, timezone).toISOString();
  const weekStart = inZone(now, timezone).startOf('day').minus({ days: 6 }).toJSDate().toISOString();
  const monthStart = startOfLocalMonth(now, timezone).toISOString();

  const split = (since: string): SpendSplit => {
    const r = db.get<{ reported: number; estimated: number; simulated: number }>(
      `SELECT ${KINDS} FROM llm_calls WHERE ts >= ?`,
      since,
    )!;
    return { providerReportedUsd: r.reported, estimatedUsd: r.estimated, simulatedUsd: r.simulated };
  };

  const group = (column: 'model' | 'feature'): GroupRow[] =>
    db
      .all<{ key: string; calls: number; i: number; o: number; c: number; real: number; sim: number }>(
        `SELECT ${column} AS key, COUNT(*) AS calls,
                SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cached_tokens) AS c,
                COALESCE(SUM(CASE WHEN cost_kind IN ('provider_reported','estimated') THEN cost_usd END), 0) AS real,
                COALESCE(SUM(CASE WHEN cost_kind = 'simulated' THEN cost_usd END), 0) AS sim
         FROM llm_calls WHERE ts >= ? GROUP BY ${column} ORDER BY calls DESC, key ASC`,
        monthStart,
      )
      .map((r) => ({
        key: r.key,
        calls: r.calls,
        inputTokens: r.i,
        outputTokens: r.o,
        cachedTokens: r.c,
        realCostUsd: r.real,
        simulatedCostUsd: r.sim,
      }));

  const c = db.get<{
    total: number;
    ok: number;
    invalid: number;
    errors: number;
    blocked: number;
    timeouts: number;
    retries: number;
    fallbacks: number;
    latency: number | null;
  }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(outcome = 'ok'), 0) AS ok,
            COALESCE(SUM(outcome = 'invalid_output'), 0) AS invalid,
            COALESCE(SUM(outcome = 'error'), 0) AS errors,
            COALESCE(SUM(outcome = 'blocked_budget'), 0) AS blocked,
            COALESCE(SUM(timed_out), 0) AS timeouts,
            COALESCE(SUM(attempt > 1), 0) AS retries,
            COALESCE(SUM(is_fallback), 0) AS fallbacks,
            AVG(CASE WHEN outcome != 'blocked_budget' THEN latency_ms END) AS latency
     FROM llm_calls WHERE ts >= ?`,
    monthStart,
  )!;

  const w = db.get<{ total: number; ok: number; failed: number; open: number; det: number; llm: number; realOk: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(succeeded = 1), 0) AS ok,
            COALESCE(SUM(succeeded = 0), 0) AS failed,
            COALESCE(SUM(succeeded IS NULL), 0) AS open,
            COALESCE(SUM(deterministic = 1), 0) AS det,
            COALESCE(SUM(deterministic = 0), 0) AS llm,
            COALESCE(SUM(succeeded = 1 AND simulated = 0), 0) AS realOk
     FROM workflow_runs WHERE started_at >= ?`,
    monthStart,
  )!;

  const month = split(monthStart);
  const realMonth = month.providerReportedUsd + month.estimatedUsd;

  // Baseline: compare like with like. Real calls if there are any, otherwise the simulated ones
  // (clearly labeled), so a fresh install still shows how the comparison works.
  const base = (kinds: string): { actual: number; baseline: number; n: number } => {
    const r = db.get<{ actual: number; baseline: number; n: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS actual, COALESCE(SUM(baseline_cost_usd), 0) AS baseline, COUNT(*) AS n
       FROM llm_calls WHERE ts >= ? AND cost_kind IN ${kinds} AND baseline_cost_usd IS NOT NULL`,
      monthStart,
    )!;
    return r;
  };
  const real = base("('provider_reported','estimated')");
  const sim = base("('simulated')");
  const chosen = real.n > 0 ? real : sim;
  const basis: UsageReport['baseline']['basis'] =
    real.n > 0 ? 'real calls this month' : sim.n > 0 ? 'simulated calls this month (demo only)' : 'no calls yet';
  const diff = chosen.baseline - chosen.actual;

  const caveats = [
    'Hypothetical: the same token counts priced at Claude API list prices. A different model would use a different number of tokens.',
    'Token-equivalent only. It does NOT show the cheaper models gave equal-quality results.',
    'Compared against pay-per-token Claude API pricing, not a flat-rate Claude subscription (Max/Pro), which is billed differently.',
    `Baseline prices are a snapshot dated ${CLAUDE_API_PRICES_DATE}; check the current Anthropic price list.`,
    `Where a cache-read price is unknown it is assumed to be ${ASSUMED_CACHE_READ_FRACTION * 100}% of the input price.`,
    'Failed and retried calls are included on both sides when they consumed tokens.',
  ];
  if (month.estimatedUsd > 0) caveats.push('Some actual costs are HomePilot estimates from a price table, not provider-reported charges.');
  if (basis.startsWith('simulated')) caveats.push('These figures come from the offline mock provider. No money was spent and no real model was called.');
  if (!CLAUDE_API_PRICES[deps.baselineModel]) caveats.push(`No price on file for baseline model "${deps.baselineModel}", so no baseline could be computed.`);

  const usedFraction = deps.monthlyBudgetUsd > 0 ? realMonth / deps.monthlyBudgetUsd : null;

  return {
    generatedAt: now.toISOString(),
    timezone,
    containsSimulatedData: month.simulatedUsd > 0 || sim.n > 0,
    spend: { today: split(dayStart), last7Days: split(weekStart), thisMonth: month },
    byModel: group('model'),
    byFeature: group('feature'),
    calls: {
      total: c.total,
      ok: c.ok,
      invalidOutput: c.invalid,
      errors: c.errors,
      blockedByBudget: c.blocked,
      timeouts: c.timeouts,
      retries: c.retries,
      fallbacks: c.fallbacks,
      avgLatencyMs: c.latency === null ? null : Math.round(c.latency),
    },
    workflows: {
      total: w.total,
      succeeded: w.ok,
      failed: w.failed,
      unfinished: w.open,
      failureRate: w.ok + w.failed > 0 ? w.failed / (w.ok + w.failed) : null,
      deterministic: w.det,
      usedModel: w.llm,
      costPerSuccessfulWorkflowUsd: w.realOk > 0 ? realMonth / w.realOk : null,
    },
    baseline: {
      model: deps.baselineModel,
      priceDate: CLAUDE_API_PRICES_DATE,
      hypotheticalClaudeOnlyUsd: chosen.baseline,
      actualUsd: chosen.actual,
      differenceUsd: diff,
      differencePct: chosen.baseline > 0 ? (diff / chosen.baseline) * 100 : null,
      basis,
      caveats,
    },
    budget: {
      monthlyUsd: deps.monthlyBudgetUsd,
      usedUsd: realMonth,
      usedFraction,
      thresholds: deps.alertThresholds.map((at) => ({ at, crossed: usedFraction !== null && usedFraction >= at })),
    },
    otherCosts: db
      .all<{ category: string; amount: number; cost_kind: string }>(
        'SELECT category, SUM(amount_usd) AS amount, cost_kind FROM other_costs WHERE ts >= ? GROUP BY category, cost_kind ORDER BY category',
        monthStart,
      )
      .map((r) => ({ category: r.category, amountUsd: r.amount, costKind: r.cost_kind })),
    priceAssumptions: [
      ...deps.prices.list().map((p) => ({
        model: p.model,
        inputPerMTok: p.inputPerMTok,
        outputPerMTok: p.outputPerMTok,
        cacheReadPerMTok: p.cacheReadPerMTok,
        source: p.source,
        asOf: p.sourceTs,
      })),
      ...Object.entries(CLAUDE_API_PRICES).map(([model, p]) => ({
        model: `${model} (baseline)`,
        inputPerMTok: p.input,
        outputPerMTok: p.output,
        cacheReadPerMTok: p.cacheRead,
        source: 'Anthropic API list price snapshot',
        asOf: CLAUDE_API_PRICES_DATE,
      })),
    ],
  };
}

const usd = (n: number): string => (n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`);

function splitLine(label: string, s: SpendSplit): string {
  const real = s.providerReportedUsd + s.estimatedUsd;
  const parts = [`${usd(real)} real`];
  if (real > 0) parts.push(`(${usd(s.providerReportedUsd)} provider-reported, ${usd(s.estimatedUsd)} estimated)`);
  if (s.simulatedUsd > 0) parts.push(`+ ${usd(s.simulatedUsd)} SIMULATED (not billed)`);
  return `  ${label.padEnd(13)} ${parts.join(' ')}`;
}

/** Plain-text usage report for the CLI. Contains no prompt text, message content or secrets. */
export function formatUsageReport(r: UsageReport): string {
  const out: string[] = [];
  out.push(`HomePilot usage report (${r.timezone}), generated ${r.generatedAt}`);
  if (r.containsSimulatedData) {
    out.push('NOTE: includes SIMULATED data from the offline mock model. Simulated cost was never billed.');
  }
  out.push('', 'Model spend');
  out.push(splitLine('Today', r.spend.today), splitLine('Last 7 days', r.spend.last7Days), splitLine('This month', r.spend.thisMonth));

  const table = (title: string, rows: GroupRow[]): void => {
    out.push('', title);
    if (rows.length === 0) {
      out.push('  (no model calls this month)');
      return;
    }
    for (const g of rows) {
      const cost = g.simulatedCostUsd > 0 && g.realCostUsd === 0 ? `${usd(g.simulatedCostUsd)} simulated` : usd(g.realCostUsd);
      out.push(`  ${g.key.padEnd(38)} calls ${String(g.calls).padStart(4)}  in ${String(g.inputTokens).padStart(7)}  out ${String(g.outputTokens).padStart(6)}  cached ${String(g.cachedTokens).padStart(6)}  ${cost}`);
    }
  };
  table('By model (this month)', r.byModel);
  table('By feature (this month)', r.byFeature);

  out.push('', 'Model calls (this month)');
  out.push(`  total ${r.calls.total}, ok ${r.calls.ok}, invalid output ${r.calls.invalidOutput}, errors ${r.calls.errors}, blocked by budget ${r.calls.blockedByBudget}`);
  out.push(`  timeouts ${r.calls.timeouts}, retries ${r.calls.retries}, fallbacks ${r.calls.fallbacks}, avg latency ${r.calls.avgLatencyMs ?? 'n/a'} ms`);

  const wf = r.workflows;
  out.push('', 'Workflows (this month)');
  out.push(`  total ${wf.total}, succeeded ${wf.succeeded}, failed ${wf.failed}, unfinished ${wf.unfinished}, failure rate ${wf.failureRate === null ? 'n/a' : `${(wf.failureRate * 100).toFixed(1)}%`}`);
  out.push(`  deterministic (no model) ${wf.deterministic}, used a model ${wf.usedModel}`);
  out.push(`  real cost per successful workflow: ${wf.costPerSuccessfulWorkflowUsd === null ? 'n/a' : usd(wf.costPerSuccessfulWorkflowUsd)}`);

  const b = r.baseline;
  out.push('', `Claude-only comparison (HYPOTHETICAL, baseline ${b.model}, prices as of ${b.priceDate})`);
  out.push(`  basis: ${b.basis}`);
  if (b.basis !== 'no calls yet') {
    out.push(`  hypothetical Claude-only API cost: ${usd(b.hypotheticalClaudeOnlyUsd)}`);
    out.push(`  actual multi-model cost:           ${usd(b.actualUsd)}`);
    out.push(`  estimated difference:              ${usd(b.differenceUsd)}${b.differencePct === null ? '' : ` (${b.differencePct.toFixed(1)}%)`}`);
  }
  out.push('  caveats:');
  for (const cv of b.caveats) out.push(`   - ${cv}`);

  out.push('', 'Budget');
  out.push(`  ${usd(r.budget.usedUsd)} of ${usd(r.budget.monthlyUsd)} this month${r.budget.usedFraction === null ? '' : ` (${(r.budget.usedFraction * 100).toFixed(1)}%)`}`);
  out.push(`  alert thresholds: ${r.budget.thresholds.map((t) => `${Math.round(t.at * 100)}%${t.crossed ? ' CROSSED' : ''}`).join(', ')}`);

  if (r.otherCosts.length > 0) {
    out.push('', 'Non-model costs (this month)');
    for (const oc of r.otherCosts) out.push(`  ${oc.category.padEnd(20)} ${usd(oc.amountUsd)} (${oc.costKind})`);
  }

  out.push('', 'Price assumptions (USD per million tokens)');
  for (const p of r.priceAssumptions) {
    out.push(`  ${p.model.padEnd(40)} in ${p.inputPerMTok}  out ${p.outputPerMTok}  cache-read ${p.cacheReadPerMTok ?? 'unknown'}  [${p.source}, ${p.asOf}]`);
  }
  return out.join('\n');
}

const CSV_COLUMNS = [
  'id', 'ts', 'correlation_id', 'workflow', 'feature', 'task_class', 'provider', 'via', 'model',
  'input_tokens', 'output_tokens', 'cached_tokens', 'cost_usd', 'cost_kind', 'currency', 'price_source',
  'price_source_ts', 'latency_ms', 'timed_out', 'attempt', 'is_fallback', 'outcome', 'error_category',
  'baseline_model', 'baseline_cost_usd', 'baseline_price_date', 'baseline_note',
] as const;

export function exportLlmCalls(db: Db, format: 'json' | 'csv'): string {
  const rows = db.all<Record<string, string | number | null>>(`SELECT ${CSV_COLUMNS.join(', ')} FROM llm_calls ORDER BY ts ASC`);
  if (format === 'json') return JSON.stringify(rows, null, 2);
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((col) => esc(r[col])).join(','))].join('\n');
}
