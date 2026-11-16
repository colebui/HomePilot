import { afterEach, describe, expect, it } from 'vitest';
import { claudeBaseline, costFor } from '../src/models/pricing.js';
import { exportLlmCalls, formatUsageReport } from '../src/telemetry/report.js';
import type { LlmCallRecord } from '../src/telemetry/usage.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const rec = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  correlationId: 'wf_1', workflow: 'message', feature: 'intent', taskClass: 'fast', provider: 'openrouter', via: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash-1017', usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 },
  latencyMs: 800, timedOut: false, attempt: 1, isFallback: false, outcome: 'ok', ...over,
});
const row = (hh: Harness, n = 0) => hh.app.db.all<Record<string, number | string | null>>('SELECT * FROM llm_calls ORDER BY rowid')[n]!;

describe('cost math', () => {
  it('prices fresh input, cached input and output separately', () => {
    const price = { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 };
    expect(costFor({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 }, price).usd).toBeCloseTo(4, 10);
    expect(costFor({ inputTokens: 0, outputTokens: 1_000_000, cachedTokens: 0 }, price).usd).toBeCloseTo(20, 10);
    // 1M input of which 600k cached: 400k x $4 + 600k x $0.20 = 1.6 + 0.12
    expect(costFor({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 600_000 }, price).usd).toBeCloseTo(1.72, 10);
    // Cached can never exceed input.
    expect(costFor({ inputTokens: 100, outputTokens: 0, cachedTokens: 500 }, price).usd).toBeCloseTo((100 * 0.2) / 1e6, 12);
  });

  it('labels the assumption when a cache price is unknown', () => {
    const est = costFor({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 }, { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: null });
    expect(est.usd).toBeCloseTo(0.01, 10);
    expect(est.note).toMatch(/cache-read price unknown; assumed 10%/);
  });

  it('computes the Claude-only baseline with its model and price date', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 };
    expect(claudeBaseline(usage, 'claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5', usd: 6, priceDate: '2026-11-03' });
    expect(claudeBaseline(usage, 'claude-sonnet-5-5')!.usd).toBeCloseTo(3, 10);
    expect(claudeBaseline(usage, 'claude-fable-5-2')!.usd).toBeCloseTo(12, 10);
    expect(claudeBaseline(usage, 'made-up-model')).toBeUndefined();
  });
});

describe('telemetry records', () => {
  it('prefers the provider-reported charge and stores every required field', () => {
    h = harness();
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 0.2345, usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 250_000 } }));
    expect(row(h)).toMatchObject({
      ts: '2026-11-16T15:00:00.000Z', correlation_id: 'wf_1', workflow: 'message', feature: 'intent', provider: 'openrouter', via: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash-1017', input_tokens: 1_000_000, output_tokens: 100_000, cached_tokens: 250_000,
      cost_usd: 0.2345, cost_kind: 'provider_reported', currency: 'USD', price_source: 'openrouter response usage.cost',
      price_source_ts: '2026-11-16T15:00:00.000Z', latency_ms: 800, timed_out: 0, attempt: 1, is_fallback: 0, outcome: 'ok',
      baseline_model: 'claude-opus-5-5', baseline_price_date: '2026-11-03',
    });
    // Baseline: 750k x $4 + 250k x $0.20 + 100k x $20 = 3 + 0.05 + 2
    expect(row(h).baseline_cost_usd).toBeCloseTo(5.05, 10);
  });

  it('labels a price-table cost as an estimate, and flags a missing price as understated', () => {
    h = harness();
    h.app.telemetry.recordLlmCall(rec());
    expect(row(h)).toMatchObject({ cost_kind: 'estimated', price_source: 'openrouter catalog (seed snapshot)', price_source_ts: '2026-11-16' });
    expect(row(h).cost_usd).toBeCloseTo(0.15 + 0.06, 10);

    h.app.telemetry.recordLlmCall(rec({ model: 'unknown/brand-new-model' }));
    expect(row(h, 1)).toMatchObject({ cost_kind: 'estimated', cost_usd: 0 });
    expect(String(row(h, 1).baseline_note)).toMatch(/UNDERSTATED/);
  });

  it('marks mock-provider calls as simulated and never as real spend', () => {
    h = harness();
    h.app.telemetry.recordLlmCall(rec({ via: 'mock', provider: 'mock' }));
    expect(row(h).cost_kind).toBe('simulated');
    expect(h.app.telemetry.monthSpendUsd()).toBe(0);
  });

  it('stores no prompt or response text anywhere in llm_calls', () => {
    h = harness();
    const cols = h.app.db.all<{ name: string }>("SELECT name FROM pragma_table_info('llm_calls')").map((c) => c.name);
    expect(cols.some((c) => /prompt|response|content|text|message/i.test(c))).toBe(false);
  });
});

describe('usage report', () => {
  function seed(hh: Harness): void {
    const t = hh.app.telemetry;
    // Two workflows: one succeeds after a retry and a fallback, one fails.
    const a = t.startWorkflow({ workflow: 'message', feature: 'intent', correlationId: 'wf_a' });
    t.recordLlmCall(rec({ correlationId: 'wf_a', outcome: 'invalid_output', reportedCostUsd: 0.1 }));
    t.recordLlmCall(rec({ correlationId: 'wf_a', attempt: 2, reportedCostUsd: 0.1 }));
    a.finish({ succeeded: true });
    const b = t.startWorkflow({ workflow: 'research', feature: 'travel', correlationId: 'wf_b' });
    t.recordLlmCall(rec({ correlationId: 'wf_b', feature: 'travel', model: 'openai/gpt-6.1-terra', isFallback: true, timedOut: true, outcome: 'error', errorCategory: 'timeout', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } }));
    t.recordLlmCall(rec({ correlationId: 'wf_b', feature: 'travel', model: 'openai/gpt-6.1-terra', usage: { inputTokens: 200_000, outputTokens: 50_000, cachedTokens: 0 } }));
    b.finish({ succeeded: false });
    // One deterministic workflow with no model.
    t.startWorkflow({ workflow: 'reminder.fire', feature: 'reminders', correlationId: 'wf_c' }).finish({ succeeded: true });
    t.recordOtherCost({ category: 'search_api', amountUsd: 0.05, costKind: 'estimated', description: 'demo' });
  }

  it('adds up spend, calls, workflows and the baseline comparison correctly', () => {
    h = harness({ env: { HOMEPILOT_MONTHLY_BUDGET_USD: '1' } });
    seed(h);
    const r = h.app.usageReport();

    // gpt-6.1-terra estimate: 200k x $1 + 50k x $5 = 0.2 + 0.25
    expect(r.spend.thisMonth.providerReportedUsd).toBeCloseTo(0.2, 10);
    expect(r.spend.thisMonth.estimatedUsd).toBeCloseTo(0.45, 10);
    expect(r.spend.thisMonth.simulatedUsd).toBe(0);
    expect(r.spend.today).toEqual(r.spend.thisMonth);
    expect(r.containsSimulatedData).toBe(false);

    expect(r.calls).toMatchObject({ total: 4, ok: 2, invalidOutput: 1, errors: 1, timeouts: 1, retries: 1, fallbacks: 1, blockedByBudget: 0 });
    expect(r.byModel.map((m) => [m.key, m.calls])).toEqual([['deepseek/deepseek-v4.1-flash-1017', 2], ['openai/gpt-6.1-terra', 2]]);
    expect(r.byFeature.map((m) => [m.key, m.calls])).toEqual([['intent', 2], ['travel', 2]]);

    expect(r.workflows).toMatchObject({ total: 3, succeeded: 2, failed: 1, unfinished: 0, deterministic: 1, usedModel: 2 });
    expect(r.workflows.failureRate).toBeCloseTo(1 / 3, 10);
    expect(r.workflows.costPerSuccessfulWorkflowUsd).toBeCloseTo(0.65 / 2, 10);

    // Baseline on claude-opus-5-5: two calls of (1M in, 100k out) = $6 each, one of (200k, 50k) = 0.8 + 1.0
    expect(r.baseline.model).toBe('claude-opus-5-5');
    expect(r.baseline.basis).toBe('real calls this month');
    expect(r.baseline.hypotheticalClaudeOnlyUsd).toBeCloseTo(13.8, 10);
    expect(r.baseline.actualUsd).toBeCloseTo(0.65, 10);
    expect(r.baseline.differenceUsd).toBeCloseTo(13.15, 10);
    expect(r.baseline.differencePct).toBeCloseTo((13.15 / 13.8) * 100, 8);

    expect(r.budget.usedFraction).toBeCloseTo(0.65, 10);
    expect(r.budget.thresholds).toEqual([{ at: 0.5, crossed: true }, { at: 0.8, crossed: false }, { at: 1, crossed: false }]);
    expect(r.otherCosts).toEqual([{ category: 'search_api', amountUsd: 0.05, costKind: 'estimated' }]);
  });

  it('always states the uncertainty: hypothetical, not equal quality, not versus a subscription, estimates labeled', () => {
    h = harness();
    seed(h);
    const text = formatUsageReport(h.app.usageReport());
    expect(text).toMatch(/HYPOTHETICAL/);
    expect(text).toMatch(/does NOT show the cheaper models gave equal-quality results/);
    expect(text).toMatch(/not a flat-rate Claude subscription/);
    expect(text).toMatch(/estimates from a price table, not provider-reported charges/);
    expect(text).toMatch(/prices as of 2026-11-03/);
    expect(text).toMatch(/Non-model costs/);
  });

  it('keeps simulated data out of real totals and labels it wherever it appears', async () => {
    h = harness();
    h.provider.enqueue({ text: JSON.stringify({ intent: 'list' }), inputTokens: 2000, outputTokens: 100 });
    await h.say('uhh show me what I have going on');
    const r = h.app.usageReport();
    expect(r.containsSimulatedData).toBe(true);
    expect(r.spend.thisMonth.providerReportedUsd + r.spend.thisMonth.estimatedUsd).toBe(0);
    expect(r.spend.thisMonth.simulatedUsd).toBeGreaterThan(0);
    expect(r.budget.usedUsd).toBe(0);
    expect(r.baseline.basis).toBe('simulated calls this month (demo only)');
    expect(r.workflows.costPerSuccessfulWorkflowUsd).toBeNull();
    const text = formatUsageReport(r);
    expect(text).toMatch(/SIMULATED data from the offline mock model/);
    expect(text).toMatch(/No money was spent and no real model was called/);
  });

  it('separates today, the last 7 days and this month in the local time zone', () => {
    h = harness({ start: '2026-11-02T15:00:00.000Z' });
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 1 })); // Nov 2
    h.clock.set('2026-11-12T15:00:00.000Z');
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 2 })); // Nov 12
    h.clock.set('2026-11-17T04:30:00.000Z'); // 10:30 PM on Nov 16 in Chicago
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 4 }));
    h.clock.set('2026-11-17T05:30:00.000Z'); // 11:30 PM on Nov 16 in Chicago: still "today"
    const r = h.app.usageReport();
    expect(r.spend.today.providerReportedUsd).toBe(4);
    expect(r.spend.last7Days.providerReportedUsd).toBe(6);
    expect(r.spend.thisMonth.providerReportedUsd).toBe(7);
    h.clock.set('2026-12-01T06:30:00.000Z'); // Dec 1, 12:30 AM Chicago
    expect(h.app.usageReport().spend.thisMonth.providerReportedUsd).toBe(0);
  });

  it('exports usage as CSV and JSON without any content columns', () => {
    h = harness();
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 0.5 }));
    const csv = exportLlmCalls(h.app.db, 'csv').split('\n');
    expect(csv).toHaveLength(2);
    expect(csv[0]).toMatch(/^id,ts,correlation_id,workflow,feature/);
    expect(csv[0]).not.toMatch(/prompt|response|content/);
    expect(csv[1]).toContain('provider_reported');
    const json = JSON.parse(exportLlmCalls(h.app.db, 'json')) as { cost_usd: number }[];
    expect(json[0]!.cost_usd).toBe(0.5);
  });
});
