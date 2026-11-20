import { z } from 'zod';
import type { ModelPrice } from './pricing.js';
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Lenient on purpose: providers add fields over time. Only what we use is validated.
const ChatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }).loose() }).loose())
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().nullable().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullable().optional() }).loose().nullable().optional(),
    })
    .loose()
    .optional(),
});

const ModelsResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        pricing: z
          .object({
            prompt: z.union([z.string(), z.number()]).optional(),
            completion: z.union([z.string(), z.number()]).optional(),
            input_cache_read: z.union([z.string(), z.number()]).nullable().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
});

function categorize(status: number): { category: ProviderError['category']; retryable: boolean } {
  if (status === 401 || status === 403) return { category: 'auth', retryable: false };
  if (status === 402) return { category: 'insufficient_credits', retryable: false };
  if (status === 408) return { category: 'timeout', retryable: true };
  if (status === 429) return { category: 'rate_limit', retryable: true };
  if (status >= 500) return { category: 'server', retryable: true };
  return { category: 'bad_request', retryable: false };
}

/**
 * OpenRouter chat-completions adapter.
 *
 * Verified against OpenRouter's public docs on 2026-11-16 (usage accounting page): responses
 * include `usage.cost` (amount charged, USD) and `usage.prompt_tokens_details.cached_tokens`
 * without any extra request parameter. In live use since 2026-11-17; the tests use a fake fetch.
 *
 * The API key is only ever placed in the Authorization header. It is never logged or stored.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  readonly via = 'openrouter' as const;

  constructor(
    private readonly opts: { apiKey: string; baseUrl?: string; fetch?: FetchLike },
  ) {
    if (!opts.apiKey) throw new ProviderError('OpenRouter API key is missing', 'auth', false);
  }

  private get baseUrl(): string {
    return (this.opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const doFetch = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          messages,
          max_tokens: req.maxOutputTokens,
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw new ProviderError('request timed out', 'timeout', true);
      // Do not include the underlying error text verbatim: it could echo request details.
      throw new ProviderError(`network error calling OpenRouter (${err instanceof Error ? err.name : 'unknown'})`, 'network', true);
    }

    if (!res.ok) {
      const { category, retryable } = categorize(res.status);
      throw new ProviderError(`OpenRouter returned HTTP ${res.status}`, category, retryable);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('OpenRouter returned a non-JSON body', 'server', true);
    }
    const parsed = ChatResponseSchema.safeParse(body);
    if (!parsed.success) throw new ProviderError('OpenRouter response did not match the expected shape', 'server', true);

    const usage = parsed.data.usage;
    const cost = usage?.cost;
    return {
      text: parsed.data.choices[0]?.message.content ?? '',
      model: parsed.data.model ?? req.model,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      ...(typeof cost === 'number' ? { reportedCostUsd: cost } : {}),
    };
  }
}

/**
 * Fetch current prices from OpenRouter's public model catalog (GET /models).
 * The catalog lists prices as USD per token; we store USD per million tokens.
 */
export async function fetchOpenRouterPrices(opts: {
  baseUrl?: string;
  fetch?: FetchLike;
  nowIso: string;
  /** Only keep these model IDs. Omit to keep every model in the catalog. */
  only?: string[];
}): Promise<ModelPrice[]> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const base = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const res = await doFetch(`${base}/models`);
  if (!res.ok) throw new ProviderError(`OpenRouter model catalog returned HTTP ${res.status}`, categorize(res.status).category, false);
  const parsed = ModelsResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new ProviderError('OpenRouter model catalog did not match the expected shape', 'server', false);

  const want = opts.only ? new Set(opts.only) : undefined;
  const out: ModelPrice[] = [];
  for (const m of parsed.data.data) {
    if (want && !want.has(m.id)) continue;
    const input = Number(m.pricing?.prompt);
    const output = Number(m.pricing?.completion);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    const cacheRaw = m.pricing?.input_cache_read;
    const cache = cacheRaw === undefined || cacheRaw === null ? null : Number(cacheRaw);
    out.push({
      model: m.id,
      inputPerMTok: input * 1_000_000,
      outputPerMTok: output * 1_000_000,
      cacheReadPerMTok: cache !== null && Number.isFinite(cache) ? cache * 1_000_000 : null,
      source: 'openrouter catalog (live sync)',
      sourceTs: opts.nowIso,
    });
  }
  return out;
}
