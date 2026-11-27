import { afterEach, describe, expect, it } from 'vitest';
import { buildActivity, buildInsights, percentile, upcomingReminders } from '../src/api/insights.js';
import type { LlmCallRecord } from '../src/telemetry/usage.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const TZ = 'America/Chicago';
const rec = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  correlationId: 'wf_1', workflow: 'message', feature: 'intent', taskClass: 'fast', provider: 'openrouter', via: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash-1017', usage: { inputTokens: 1000, outputTokens: 100, cachedTokens: 0 },
  latencyMs: 800, timedOut: false, attempt: 1, isFallback: false, outcome: 'ok', reportedCostUsd: 0.01, ...over,
});

describe('percentile', () => {
  it('uses the nearest-rank method and handles empty input', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([...Array(100).keys()].map((i) => i + 1), 95)).toBe(95);
  });
});

describe('dashboard insights', () => {
  it('buckets spend by local day, including empty days', () => {
    h = harness();
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 0.02 }));
    h.clock.set('2026-11-14T03:00:00.000Z'); // Fri Nov 13, 9 PM in Chicago: still the 13th locally
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 0.05 }));
    h.clock.set('2026-11-16T15:00:00.000Z');

    const ins = buildInsights(h.app.db, h.clock.now(), TZ, { days: 7 });
    expect(ins.dailySpend).toHaveLength(7);
    expect(ins.dailySpend.at(-1)).toMatchObject({ date: '2026-11-16', calls: 1 });
    expect(ins.dailySpend.at(-1)!.realUsd).toBeCloseTo(0.02, 10);
    expect(ins.dailySpend.find((d) => d.date === '2026-11-13')!.realUsd).toBeCloseTo(0.05, 10);
    expect(ins.dailySpend.find((d) => d.date === '2026-11-14')!.calls).toBe(0);
  });

  it('projects month-end spend from the pace so far, and stays null with no real spend', () => {
    h = harness();
    expect(buildInsights(h.app.db, h.clock.now(), TZ).projectedMonthUsd).toBeNull();
    h.app.telemetry.recordLlmCall(rec({ reportedCostUsd: 1 }));
    // Nov 16 9 AM local is 15.375 days into a 30-day month.
    expect(buildInsights(h.app.db, h.clock.now(), TZ).projectedMonthUsd).toBeCloseTo((1 / 15.375) * 30, 6);
  });

  it('reports latency percentiles and failure rate per model, ignoring budget blocks', () => {
    h = harness();
    for (const ms of [100, 200, 300, 400]) h.app.telemetry.recordLlmCall(rec({ latencyMs: ms }));
    h.app.telemetry.recordLlmCall(rec({ latencyMs: 900, outcome: 'error' }));
    h.app.telemetry.recordLlmCall(rec({ latencyMs: 0, outcome: 'blocked_budget' }));
    h.app.telemetry.recordLlmCall(rec({ model: 'other/model', latencyMs: 50 }));
    const { latency } = buildInsights(h.app.db, h.clock.now(), TZ);
    const main = latency.byModel[0]!;
    expect(main).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-1017', calls: 6, p50Ms: 300, p95Ms: 900 });
    expect(main.failureRate).toBeCloseTo(1 / 5, 10);
    expect(latency.byModel[1]).toMatchObject({ model: 'other/model', calls: 1, failureRate: 0 });
    expect(latency.overall.calls).toBe(7);
  });

  it('counts texts the parser understood without a model', async () => {
    h = harness();
    await h.say('remind me to call the dentist tomorrow at 10am');
    await h.say('my tasks');
    const ins = buildInsights(h.app.db, h.clock.now(), TZ);
    expect(ins.texts).toMatchObject({ handled: 2, deterministic: 2, usedModel: 0, notUnderstood: 0 });
    expect(ins.today).toMatchObject({ tasksAdded: 1, textsHandled: 2, tasksCompleted: 0 });
  });
});

describe('activity feed and reminders', () => {
  it('lists what happened, newest first, with task titles', async () => {
    h = harness();
    await h.say('remind me to call the dentist at 10am');
    expect(upcomingReminders(h.app.db)).toMatchObject([{ title: 'Call the dentist', fireAt: '2026-11-16T16:00:00.000Z' }]);

    h.clock.set('2026-11-16T16:00:30.000Z');
    await h.app.tick();
    h.clock.advanceMinutes(5);
    await h.say('call the dentist done');

    const feed = buildActivity(h.app.db);
    const kinds = feed.map((f) => f.kind);
    expect(kinds).toContain('task_added');
    expect(kinds).toContain('reminder_sent');
    expect(kinds).toContain('task_completed');
    expect(kinds).toContain('text_handled');
    expect(feed.find((f) => f.kind === 'reminder_sent')!.title).toBe('Call the dentist');
    expect(feed.find((f) => f.kind === 'task_completed')!.title).toBe('Call the dentist');
    const ts = feed.map((f) => f.ts);
    expect([...ts].sort().reverse()).toEqual(ts);
    expect(upcomingReminders(h.app.db)).toEqual([]);
  });

  it('never includes the text of incoming messages', async () => {
    h = harness();
    await h.say('xyzzy plugh secret words');
    const feed = JSON.stringify(buildActivity(h.app.db));
    expect(feed).not.toContain('plugh');
  });
});
