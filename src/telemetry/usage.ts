import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { newId } from '../ids.js';
import { claudeBaseline, costFor, type PriceBook } from '../models/pricing.js';
import type { ErrorCategory, ModelUsage, TaskClass } from '../models/types.js';
import { startOfLocalMonth } from '../time.js';

export type CostKind = 'provider_reported' | 'estimated' | 'simulated' | 'none';
export type CallOutcome = 'ok' | 'invalid_output' | 'error' | 'blocked_budget';

export interface LlmCallRecord {
  correlationId: string;
  workflow: string;
  feature: string;
  taskClass: TaskClass;
  provider: string;
  via: 'openrouter' | 'direct' | 'mock';
  model: string;
  usage: ModelUsage;
  reportedCostUsd?: number;
  latencyMs: number;
  timedOut: boolean;
  attempt: number;
  isFallback: boolean;
  outcome: CallOutcome;
  errorCategory?: ErrorCategory | 'budget';
}

export interface WorkflowHandle {
  correlationId: string;
  finish(result: { succeeded: boolean; detail?: string; feature?: string }): void;
}

/**
 * Records every model attempt and every workflow, including deterministic ones that used no
 * model at all. Prompt and response text are never stored: only counts, costs and outcomes.
 */
export class Telemetry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly prices: PriceBook,
    private readonly opts: { baselineModel: string; timezone: string },
  ) {}

  recordLlmCall(rec: LlmCallRecord): string {
    const id = newId('llm');
    const hasTokens = rec.usage.inputTokens + rec.usage.outputTokens > 0;

    let costUsd = 0;
    let costKind: CostKind = 'none';
    let priceSource: string | null = null;
    let priceSourceTs: string | null = null;
    const notes: string[] = [];

    if (rec.via === 'mock') {
      // Nothing was billed. Price the simulated tokens so demo analytics have realistic shape.
      const price = this.prices.get(rec.model);
      if (hasTokens && price) {
        const est = costFor(rec.usage, price);
        costUsd = est.usd;
        costKind = 'simulated';
        priceSource = price.source;
        priceSourceTs = price.sourceTs;
        if (est.note) notes.push(est.note);
      } else if (hasTokens) {
        costKind = 'simulated';
        notes.push('no price on file for this model; simulated cost recorded as 0');
      }
    } else if (rec.reportedCostUsd !== undefined) {
      costUsd = rec.reportedCostUsd;
      costKind = 'provider_reported';
      priceSource = `${rec.provider} response usage.cost`;
      priceSourceTs = this.clock.now().toISOString();
    } else if (hasTokens) {
      const price = this.prices.get(rec.model);
      if (price) {
        const est = costFor(rec.usage, price);
        costUsd = est.usd;
        costKind = 'estimated';
        priceSource = price.source;
        priceSourceTs = price.sourceTs;
        if (est.note) notes.push(est.note);
      } else {
        costKind = 'estimated';
        notes.push('no price on file for this model; cost recorded as 0 and is UNDERSTATED');
      }
    }

    const baseline = hasTokens ? claudeBaseline(rec.usage, this.opts.baselineModel) : undefined;
    if (hasTokens && !baseline) notes.push(`no baseline price for "${this.opts.baselineModel}"`);
    if (baseline?.note) notes.push(`baseline: ${baseline.note}`);

    this.db.run(
      `INSERT INTO llm_calls (id, ts, correlation_id, workflow, feature, task_class, provider, via, model,
         input_tokens, output_tokens, cached_tokens, cost_usd, cost_kind, price_source, price_source_ts,
         latency_ms, timed_out, attempt, is_fallback, outcome, error_category,
         baseline_model, baseline_cost_usd, baseline_price_date, baseline_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.clock.now().toISOString(),
      rec.correlationId,
      rec.workflow,
      rec.feature,
      rec.taskClass,
      rec.provider,
      rec.via,
      rec.model,
      rec.usage.inputTokens,
      rec.usage.outputTokens,
      rec.usage.cachedTokens,
      costUsd,
      costKind,
      priceSource,
      priceSourceTs,
      Math.round(rec.latencyMs),
      rec.timedOut,
      rec.attempt,
      rec.isFallback,
      rec.outcome,
      rec.errorCategory ?? null,
      baseline?.model ?? null,
      baseline?.usd ?? null,
      baseline?.priceDate ?? null,
      notes.length ? notes.join('; ') : null,
    );
    return id;
  }

  recordOtherCost(c: {
    category: string;
    description?: string;
    amountUsd: number;
    costKind: Exclude<CostKind, 'none'>;
    correlationId?: string;
  }): void {
    this.db.run(
      'INSERT INTO other_costs (id, ts, correlation_id, category, description, amount_usd, cost_kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId('cost'),
      this.clock.now().toISOString(),
      c.correlationId ?? null,
      c.category,
      c.description ?? null,
      c.amountUsd,
      c.costKind,
    );
  }

  /** Open a workflow record. Call finish() exactly once with the user-visible outcome. */
  startWorkflow(w: { workflow: string; feature: string; correlationId?: string }): WorkflowHandle {
    const correlationId = w.correlationId ?? newId('wf');
    this.db.run(
      'INSERT OR IGNORE INTO workflow_runs (correlation_id, workflow, feature, started_at) VALUES (?, ?, ?, ?)',
      correlationId,
      w.workflow,
      w.feature,
      this.clock.now().toISOString(),
    );
    return {
      correlationId,
      finish: ({ succeeded, detail, feature }) => {
        const agg = this.db.get<{ n: number; sim: number }>(
          "SELECT COUNT(*) AS n, COALESCE(SUM(via = 'mock'), 0) AS sim FROM llm_calls WHERE correlation_id = ?",
          correlationId,
        )!;
        this.db.run(
          `UPDATE workflow_runs SET finished_at = ?, succeeded = ?, llm_calls = ?, deterministic = ?, simulated = ?, detail = ?,
             feature = COALESCE(?, feature)
           WHERE correlation_id = ?`,
          this.clock.now().toISOString(),
          succeeded,
          agg.n,
          agg.n === 0,
          agg.sim > 0,
          detail ? detail.slice(0, 300) : null,
          feature ?? null,
          correlationId,
        );
      },
    };
  }

  /**
   * Model spend so far this calendar month (local time zone).
   * Simulated cost is excluded unless asked for: it was never billed.
   */
  monthSpendUsd(opts: { includeSimulated?: boolean } = {}): number {
    const from = startOfLocalMonth(this.clock.now(), this.opts.timezone).toISOString();
    const kinds = opts.includeSimulated
      ? "('provider_reported','estimated','simulated')"
      : "('provider_reported','estimated')";
    return this.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE ts >= ? AND cost_kind IN ${kinds}`,
      from,
    )!.total;
  }

  callsFor(correlationId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls WHERE correlation_id = ?', correlationId)!.n;
  }
}
