import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJson } from '../src/models/router.js';
import { ProviderError } from '../src/models/types.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const Schema = z.object({ category: z.enum(['errand', 'health', 'home']), minutes: z.number().int().positive() });
const FAST = 'deepseek/deepseek-v4.1-flash-1017';
const FALLBACK = 'tencent/hy4-flash';
const req = (correlationId = 'wf_test') => ({ taskClass: 'fast' as const, workflow: 'test', feature: 'categorize', correlationId, prompt: 'Categorize: haircut', schema: Schema });
const calls = (hh: Harness) =>
  hh.app.db.all<{ model: string; outcome: string; error_category: string | null; attempt: number; is_fallback: number; timed_out: number; cost_kind: string; input_tokens: number }>(
    'SELECT model, outcome, error_category, attempt, is_fallback, timed_out, cost_kind, input_tokens FROM llm_calls ORDER BY rowid',
  );
const good = JSON.stringify({ category: 'errand', minutes: 45 });

describe('extractJson', () => {
  it('reads plain, fenced and chatty JSON, and rejects non-JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(() => extractJson('I cannot help with that')).toThrow();
  });
});

describe('ModelRouter', () => {
  it('returns validated structured output from the primary model and records the call', async () => {
    h = harness();
    h.provider.enqueue({ text: good, inputTokens: 100, outputTokens: 20 });
    const r = await h.app.router.completeStructured(req());
    expect(r).toMatchObject({ ok: true, value: { category: 'errand', minutes: 45 }, model: FAST, attempts: 1, usedFallback: false });
    expect(calls(h)).toEqual([{ model: FAST, outcome: 'ok', error_category: null, attempt: 1, is_fallback: 0, timed_out: 0, cost_kind: 'simulated', input_tokens: 100 }]);
    expect(h.provider.calls[0]).toMatchObject({ model: FAST, json: true, maxOutputTokens: 1024 });
  });

  it('retries invalid JSON within the cap, then falls back to the next model', async () => {
    h = harness(); // maxRetries = 1 -> 2 tries per model
    h.provider.enqueue({ text: 'not json at all' }, { text: JSON.stringify({ category: 'banana', minutes: -1 }) }, { text: good });
    const r = await h.app.router.completeStructured(req());
    expect(r).toMatchObject({ ok: true, model: FALLBACK, attempts: 3, usedFallback: true });
    expect(calls(h).map((c) => [c.model, c.outcome, c.attempt, c.is_fallback])).toEqual([
      [FAST, 'invalid_output', 1, 0],
      [FAST, 'invalid_output', 2, 0],
      [FALLBACK, 'ok', 1, 1],
    ]);
  });

  it('gives up safely when every model returns invalid output (strict cap, no infinite retries)', async () => {
    h = harness();
    h.provider.setDefault(() => ({ text: '{"category":"nope"}' }));
    const r = await h.app.router.completeStructured(req());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('all_models_failed');
      expect(r.attempts).toBe(4); // 2 models x (1 try + 1 retry)
    }
    expect(h.provider.calls).toHaveLength(4);
  });

  it('times out a slow model and falls back', async () => {
    h = harness({ env: { HOMEPILOT_LLM_TIMEOUT_MS: '100', HOMEPILOT_LLM_MAX_RETRIES: '0' } });
    h.provider.onModel(FAST, () => ({ hangMs: 5_000 }));
    h.provider.onModel(FALLBACK, () => ({ text: good }));
    const started = Date.now();
    const r = await h.app.router.completeStructured(req());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toMatchObject({ ok: true, model: FALLBACK, usedFallback: true });
    expect(calls(h).map((c) => [c.model, c.outcome, c.error_category, c.timed_out])).toEqual([
      [FAST, 'error', 'timeout', 1],
      [FALLBACK, 'ok', null, 0],
    ]);
  });

  it('retries a rate limit, skips to the fallback on a non-retryable error, and stops on an auth error', async () => {
    h = harness();
    h.provider.enqueue({ error: new ProviderError('429', 'rate_limit', true) }, { text: good });
    expect(await h.app.router.completeStructured(req('wf_a'))).toMatchObject({ ok: true, model: FAST, attempts: 2 });

    h.provider.enqueue({ error: new ProviderError('400', 'bad_request', false) }, { text: good });
    expect(await h.app.router.completeStructured(req('wf_b'))).toMatchObject({ ok: true, model: FALLBACK, attempts: 2 });

    h.provider.enqueue({ error: new ProviderError('401', 'auth', false) });
    const r = await h.app.router.completeStructured(req('wf_c'));
    expect(r).toMatchObject({ ok: false, reason: 'all_models_failed', attempts: 1 }); // a bad key fails every model: stop
    expect(h.provider.calls).toHaveLength(5);
  });

  it('enforces the monthly spend ceiling before calling, and records the block', async () => {
    h = harness({ env: { HOMEPILOT_MONTHLY_BUDGET_USD: '0.001' }, app: { budgetIncludesSimulated: true } });
    // 5000 in + 1000 out on the fast model = $0.00135, which crosses the $0.001 ceiling.
    h.provider.enqueue({ text: good, inputTokens: 5000, outputTokens: 1000 });
    expect((await h.app.router.completeStructured(req('wf_1'))).ok).toBe(true);

    const blocked = await h.app.router.completeStructured(req('wf_2'));
    expect(blocked).toMatchObject({ ok: false, reason: 'budget_exceeded', attempts: 0 });
    expect(h.provider.calls).toHaveLength(1); // the provider was never called the second time
    expect(calls(h)[1]).toMatchObject({ outcome: 'blocked_budget', error_category: 'budget', cost_kind: 'none' });

    // Budget alerts fire once per threshold, not once per call.
    await h.app.router.completeStructured(req('wf_3'));
    const alerts = h.app.notifier.list({ kind: 'budget' });
    expect(alerts).toHaveLength(3); // 50%, 80%, 100% all crossed by the first call
    expect(alerts.some((a) => a.body.includes('Model calls are now blocked'))).toBe(true);

    // A new month resets the ceiling.
    h.clock.set('2026-12-01T15:00:00.000Z');
    h.provider.enqueue({ text: good, inputTokens: 10, outputTokens: 10 });
    expect((await h.app.router.completeStructured(req('wf_4'))).ok).toBe(true);
  });

  it('simulated spend does not count toward the real budget by default', async () => {
    h = harness({ env: { HOMEPILOT_MONTHLY_BUDGET_USD: '0.001' } });
    h.provider.setDefault(() => ({ text: good, inputTokens: 50_000, outputTokens: 10_000 }));
    for (let i = 0; i < 3; i++) expect((await h.app.router.completeStructured(req(`wf_${i}`))).ok).toBe(true);
    expect(h.app.telemetry.monthSpendUsd()).toBe(0);
    expect(h.app.telemetry.monthSpendUsd({ includeSimulated: true })).toBeGreaterThan(0.03);
  });

  it('limits concurrency', async () => {
    h = harness({ env: { HOMEPILOT_LLM_MAX_CONCURRENCY: '2' } });
    let active = 0;
    let peak = 0;
    const original = h.provider.complete.bind(h.provider);
    h.provider.complete = async (r) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 20));
      active--;
      return original(r);
    };
    h.provider.setDefault(() => ({ text: good }));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => h.app.router.completeStructured(req(`wf_${i}`))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });
});

describe('model fallback in the message path', () => {
  it('a model outage never blocks or corrupts anything: the user gets a safe reply', async () => {
    h = harness();
    h.provider.setDefault(() => ({ error: new ProviderError('503', 'server', true) }));
    const reply = await h.say('hmm what was that thing about the gutters');
    expect(reply).toContain("so I did nothing");
    expect(h.app.tasks.list()).toHaveLength(0);
    // Deterministic commands keep working with the model down.
    expect(await h.say('remind me to clean the gutters tomorrow')).toContain('Saved "Clean the gutters"');
  });

  it('the model supplies words, never dates: HomePilot does the calendar math', async () => {
    h = harness();
    // The model tries to smuggle in its own (wrong) timestamp; only when_text is honored.
    h.provider.enqueue({ text: JSON.stringify({ intent: 'add_task', title: 'renew passport', when_text: 'by friday', due: '1999-01-01T00:00:00Z', remind: true }) });
    const reply = await h.say('passport renewal needs sorting out by friday pls');
    expect(reply).toContain('Saved "Renew passport". Due by Fri Nov 20, 11:59 PM CST. I\'ll remind you Fri Nov 20, 9:00 AM CST.');
    const wf = h.app.db.get<{ deterministic: number; llm_calls: number; simulated: number; feature: string }>("SELECT deterministic, llm_calls, simulated, feature FROM workflow_runs WHERE workflow = 'message'")!;
    expect(wf).toEqual({ deterministic: 0, llm_calls: 1, simulated: 1, feature: 'reminders' });
  });

  it('a reply says which model read the message, and only when a model did', async () => {
    h = harness();
    // Plain code understood it: no note.
    expect(await h.say('remind me to call mom tomorrow')).not.toContain('read by');
    // The first fast model fails, so the fallback serves it; the note names the model that actually answered.
    const [first, second] = h.app.config.models.fast;
    h.provider.enqueue({ error: new ProviderError('503', 'server', true) }, { error: new ProviderError('503', 'server', true) });
    h.provider.onModel(second!, () => ({ text: JSON.stringify({ intent: 'add_task', title: 'Clean the gutters', when_text: 'next week' }) }));
    const r = await h.app.handleMessage({ sender: 'local-cli', channel: 'cli', text: 'gutters want cleaning next week' });
    expect(r.understoodBy).toBe('model');
    expect(r.model).toBe(second);
    expect(r.model).not.toBe(first);
    expect(r.reply).toContain('Saved "Clean the gutters"');
    expect(r.reply!.endsWith(`\n(read by ${second})`)).toBe(true);
  });

  it('the model note can be turned off', async () => {
    h = harness({ env: { HOMEPILOT_REPLY_SHOWS_MODEL: 'false' } });
    h.provider.enqueue({ text: JSON.stringify({ intent: 'list' }) });
    const r = await h.app.handleMessage({ sender: 'local-cli', channel: 'cli', text: 'what have I got on' });
    expect(r.model).toBeDefined();
    expect(r.reply).not.toContain('read by');
  });
});
