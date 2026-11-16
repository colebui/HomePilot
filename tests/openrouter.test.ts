import { describe, expect, it } from 'vitest';
import { fetchOpenRouterPrices, OpenRouterProvider, type FetchLike } from '../src/models/openrouter.js';
import { ProviderError } from '../src/models/types.js';

const KEY = 'sk-or-v1-TEST-ONLY-not-a-real-key';
const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function capture(response: () => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return response();
  };
  return { fetch, seen };
}

// Shape taken from OpenRouter's usage-accounting documentation (read 2026-11-16).
const COMPLETION = {
  id: 'gen-1',
  model: 'deepseek/deepseek-v4.1-flash-1017',
  choices: [{ message: { role: 'assistant', content: '{"intent":"list"}' } }],
  usage: {
    prompt_tokens: 194,
    completion_tokens: 2,
    total_tokens: 196,
    cost: 0.00095,
    cost_details: { upstream_inference_cost: 0.0009 },
    prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

describe('OpenRouterProvider (fake fetch; the live API has not been called)', () => {
  it('sends a chat completion request with the key only in the Authorization header', async () => {
    const { fetch, seen } = capture(() => ok(COMPLETION));
    const p = new OpenRouterProvider({ apiKey: KEY, fetch });
    await p.complete({ model: 'deepseek/deepseek-v4.1-flash-1017', system: 'sys', prompt: 'hello', maxOutputTokens: 256, json: true });

    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = seen[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(body).toEqual({
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });
    expect(String(seen[0]!.init!.body)).not.toContain(KEY);
  });

  it('reads tokens, cached tokens and the charged amount from the response', async () => {
    const { fetch } = capture(() => ok(COMPLETION));
    const res = await new OpenRouterProvider({ apiKey: KEY, fetch }).complete({ model: 'x', prompt: 'hi', maxOutputTokens: 10 });
    expect(res).toEqual({
      text: '{"intent":"list"}',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      usage: { inputTokens: 194, outputTokens: 2, cachedTokens: 100 },
      reportedCostUsd: 0.00095,
    });
  });

  it('tolerates a response with no usage block (cost then has to be estimated)', async () => {
    const { fetch } = capture(() => ok({ choices: [{ message: { content: 'hi' } }] }));
    const res = await new OpenRouterProvider({ apiKey: KEY, fetch }).complete({ model: 'm', prompt: 'hi', maxOutputTokens: 10 });
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(res.reportedCostUsd).toBeUndefined();
    expect(res.model).toBe('m');
  });

  it.each([
    [401, 'auth', false],
    [402, 'insufficient_credits', false],
    [429, 'rate_limit', true],
    [500, 'server', true],
    [503, 'server', true],
    [400, 'bad_request', false],
  ] as const)('maps HTTP %i to %s (retryable: %s) without leaking the key', async (status, category, retryable) => {
    const { fetch } = capture(() => ok({ error: { message: `bad things, key was ${KEY}` } }, status));
    const err = await new OpenRouterProvider({ apiKey: KEY, fetch }).complete({ model: 'm', prompt: 'hi', maxOutputTokens: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ category, retryable });
    expect((err as Error).message).not.toContain(KEY);
  });

  it('classifies network failures, aborts and malformed bodies', async () => {
    const boom: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(new OpenRouterProvider({ apiKey: KEY, fetch: boom }).complete({ model: 'm', prompt: 'x', maxOutputTokens: 1 })).rejects.toMatchObject({ category: 'network', retryable: true });

    const controller = new AbortController();
    controller.abort();
    await expect(new OpenRouterProvider({ apiKey: KEY, fetch: boom }).complete({ model: 'm', prompt: 'x', maxOutputTokens: 1, signal: controller.signal })).rejects.toMatchObject({ category: 'timeout' });

    const { fetch } = capture(() => ok({ nonsense: true }));
    await expect(new OpenRouterProvider({ apiKey: KEY, fetch }).complete({ model: 'm', prompt: 'x', maxOutputTokens: 1 })).rejects.toMatchObject({ category: 'server' });
  });

  it('refuses to construct without a key', () => {
    expect(() => new OpenRouterProvider({ apiKey: '' })).toThrow(/key is missing/);
  });
});

describe('fetchOpenRouterPrices', () => {
  // Field names and units (USD per token, as strings) as observed in the public catalog on 2026-11-16.
  const CATALOG = {
    data: [
      { id: 'tencent/hy4-flash', pricing: { prompt: '0.000000035', completion: '0.0000001405', input_cache_read: '0.0000000015' } },
      { id: 'anthropic/claude-fable-5.2', pricing: { prompt: '0.000008', completion: '0.00004', input_cache_read: '0.0000002' } },
      { id: 'google/gemini-omni-1.2-flash', pricing: { prompt: '0.0000015', completion: '0.000009' } },
      { id: 'broken/model', pricing: { prompt: 'n/a', completion: '-1' } },
    ],
  };

  it('converts per-token prices to per-million and records when they were read', async () => {
    const { fetch, seen } = capture(() => ok(CATALOG));
    const prices = await fetchOpenRouterPrices({ fetch, nowIso: '2026-11-16T21:00:00.000Z' });
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(prices.map((p) => p.model)).toEqual(['tencent/hy4-flash', 'anthropic/claude-fable-5.2', 'google/gemini-omni-1.2-flash']);
    const fable = prices[1]!;
    expect(fable.inputPerMTok).toBeCloseTo(8, 9);
    expect(fable.outputPerMTok).toBeCloseTo(40, 9);
    expect(fable.cacheReadPerMTok).toBeCloseTo(0.2, 9);
    expect(fable.sourceTs).toBe('2026-11-16T21:00:00.000Z');
    expect(prices[2]!.cacheReadPerMTok).toBeNull(); // unknown stays unknown, never guessed here
  });

  it('can be limited to the configured models, and reports catalog failures', async () => {
    const { fetch } = capture(() => ok(CATALOG));
    const only = await fetchOpenRouterPrices({ fetch, nowIso: 'x', only: ['tencent/hy4-flash', 'not/listed'] });
    expect(only.map((p) => p.model)).toEqual(['tencent/hy4-flash']);
    const down = capture(() => ok({}, 503));
    await expect(fetchOpenRouterPrices({ fetch: down.fetch, nowIso: 'x' })).rejects.toBeInstanceOf(ProviderError);
  });
});
