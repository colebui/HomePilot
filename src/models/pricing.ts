import type { Db } from '../db/database.js';
import type { ModelUsage } from './types.js';

export interface ModelPrice {
  model: string;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cached-read input tokens. null = not known. */
  cacheReadPerMTok: number | null;
  source: string;
  /** When the price was observed (ISO date or timestamp). Prices change; this is a snapshot. */
  sourceTs: string;
}

/**
 * Anthropic first-party API list prices used ONLY for the hypothetical "Claude-only" baseline.
 * Snapshot dated 2026-11-03. These are NOT what a Claude Max/Pro subscription costs, and they are
 * not OpenRouter prices. Verify against https://www.anthropic.com/pricing before relying on them.
 */
export const CLAUDE_API_PRICES_DATE = '2026-11-03';
export const CLAUDE_API_PRICES: Record<string, { input: number; output: number; cacheRead: number | null }> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  // Haiku 5.5 price applies to prompts up to 100K tokens; its cache-read price is not in our snapshot.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: null },
};

/**
 * OpenRouter prices seen in the public model catalog on 2026-11-16 for the example models in
 * .env.example. Seeded so cost estimates work offline. `homepilot models sync` replaces them
 * with live values. They are estimates until a provider-reported charge is recorded.
 */
export const OPENROUTER_SEED_DATE = '2026-11-16';
export const OPENROUTER_SEED_PRICES: Record<string, { input: number; output: number; cacheRead: number | null }> = {
  'deepseek/deepseek-v4.1-flash-1017': { input: 0.15, output: 0.6, cacheRead: 0.003 },
  'tencent/hy4-flash': { input: 0.035, output: 0.1405, cacheRead: 0.0015 },
  'openai/gpt-6.1-terra': { input: 1, output: 5, cacheRead: 0.05 },
  'google/gemini-4-hydrogen': { input: 1.5, output: 7.5, cacheRead: 0.075 },
  'anthropic/claude-fable-5.2': { input: 8, output: 40, cacheRead: 0.2 },
};

/** When a cache-read price is unknown we assume this fraction of the input price, and say so. */
export const ASSUMED_CACHE_READ_FRACTION = 0.1;

export interface CostEstimate {
  usd: number;
  /** Set when an assumption was needed (for example an unknown cache price). */
  note?: string;
}

/** Token-based cost: non-cached input + cached input + output. */
export function costFor(usage: ModelUsage, price: Pick<ModelPrice, 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok'>): CostEstimate {
  const cached = Math.min(Math.max(0, usage.cachedTokens), usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  let note: string | undefined;
  let cacheRate = price.cacheReadPerMTok;
  if (cacheRate === null) {
    cacheRate = price.inputPerMTok * ASSUMED_CACHE_READ_FRACTION;
    if (cached > 0) note = `cache-read price unknown; assumed ${ASSUMED_CACHE_READ_FRACTION * 100}% of input price`;
  }
  const usd = (fresh * price.inputPerMTok + cached * cacheRate + usage.outputTokens * price.outputPerMTok) / 1_000_000;
  return note ? { usd, note } : { usd };
}

interface PriceRow {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number | null;
  source: string;
  source_ts: string;
}

export class PriceBook {
  constructor(private readonly db: Db) {}

  /** Insert seed prices without overwriting anything newer (for example from `models sync`). */
  seedDefaults(): void {
    for (const [model, p] of Object.entries(OPENROUTER_SEED_PRICES)) {
      this.db.run(
        `INSERT OR IGNORE INTO model_prices (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, source, source_ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
        model,
        p.input,
        p.output,
        p.cacheRead,
        'openrouter catalog (seed snapshot)',
        OPENROUTER_SEED_DATE,
      );
    }
  }

  upsert(p: ModelPrice): void {
    this.db.run(
      `INSERT INTO model_prices (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, source, source_ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET input_per_mtok = excluded.input_per_mtok,
         output_per_mtok = excluded.output_per_mtok, cache_read_per_mtok = excluded.cache_read_per_mtok,
         source = excluded.source, source_ts = excluded.source_ts`,
      p.model,
      p.inputPerMTok,
      p.outputPerMTok,
      p.cacheReadPerMTok,
      p.source,
      p.sourceTs,
    );
  }

  get(model: string): ModelPrice | undefined {
    const r = this.db.get<PriceRow>('SELECT * FROM model_prices WHERE model = ?', model);
    return r
      ? {
          model: r.model,
          inputPerMTok: r.input_per_mtok,
          outputPerMTok: r.output_per_mtok,
          cacheReadPerMTok: r.cache_read_per_mtok,
          source: r.source,
          sourceTs: r.source_ts,
        }
      : undefined;
  }

  list(): ModelPrice[] {
    return this.db.all<PriceRow>('SELECT * FROM model_prices ORDER BY model').map((r) => ({
      model: r.model,
      inputPerMTok: r.input_per_mtok,
      outputPerMTok: r.output_per_mtok,
      cacheReadPerMTok: r.cache_read_per_mtok,
      source: r.source,
      sourceTs: r.source_ts,
    }));
  }
}

export interface BaselineCost {
  model: string;
  usd: number;
  priceDate: string;
  note?: string;
}

/**
 * What the same token workload would cost on one Claude API model at list price.
 * HYPOTHETICAL: a different model would use a different number of tokens and give different
 * quality, so this is a token-equivalent comparison, not proof of equal-quality savings.
 */
export function claudeBaseline(usage: ModelUsage, baselineModel: string): BaselineCost | undefined {
  const p = CLAUDE_API_PRICES[baselineModel];
  if (!p) return undefined;
  const est = costFor(usage, { inputPerMTok: p.input, outputPerMTok: p.output, cacheReadPerMTok: p.cacheRead });
  return { model: baselineModel, usd: est.usd, priceDate: CLAUDE_API_PRICES_DATE, ...(est.note ? { note: est.note } : {}) };
}
