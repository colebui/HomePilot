import { existsSync } from 'node:fs';
import { IANAZone } from 'luxon';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected true/false, got "${v}"` });
      return z.NEVER;
    });

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected integer ${min}..${max}, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const num = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected number ${min}..${max}, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const hhmm = (def: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const s = v === undefined || v === '' ? def : v.trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
        ctx.addIssue({ code: 'custom', message: `expected HH:MM (24h), got "${s}"` });
        return z.NEVER;
      }
      return s;
    });

const csv = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    });

const EnvSchema = z.object({
  HOMEPILOT_DB_PATH: z.string().optional().default('./data/homepilot.db'),
  HOMEPILOT_TIMEZONE: z
    .string()
    .optional()
    .default('America/Chicago')
    .refine((tz) => IANAZone.isValidZone(tz), { message: 'not a valid IANA time zone' }),
  HOMEPILOT_DRY_RUN: bool(true),
  HOMEPILOT_ALLOWED_SENDERS: csv(['local-cli']),
  HOMEPILOT_AGENT_CHANNELS: csv(['openclaw']),

  HOMEPILOT_QUIET_HOURS_START: hhmm('22:00'),
  HOMEPILOT_QUIET_HOURS_END: hhmm('08:00'),
  HOMEPILOT_MAX_NUDGES_PER_DAY: int(3, 0, 50),
  HOMEPILOT_NUDGE_COOLDOWN_MINUTES: int(240, 1, 10_080),
  HOMEPILOT_NUDGE_INTERVAL_MINUTES: int(30, 1, 1440),

  HOMEPILOT_MODEL_PROVIDER: z.enum(['mock', 'openrouter']).optional().default('mock'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.url().optional().default('https://openrouter.ai/api/v1'),
  HOMEPILOT_MODEL_FAST: csv(['deepseek/deepseek-v4.1-flash-1017', 'tencent/hy4-flash']),
  HOMEPILOT_MODEL_BALANCED: csv(['openai/gpt-6.1-terra', 'google/gemini-4-hydrogen']),
  HOMEPILOT_MODEL_PREMIUM: csv(['anthropic/claude-fable-5.2']),
  HOMEPILOT_LLM_TIMEOUT_MS: int(20_000, 100, 600_000),
  HOMEPILOT_LLM_MAX_RETRIES: int(1, 0, 5),
  HOMEPILOT_LLM_MAX_CONCURRENCY: int(2, 1, 16),
  HOMEPILOT_LLM_MAX_OUTPUT_TOKENS: int(512, 16, 32_000),

  HOMEPILOT_MONTHLY_BUDGET_USD: num(20, 0, 100_000),
  HOMEPILOT_BUDGET_ALERT_THRESHOLDS: csv(['0.5', '0.8', '1.0']).transform((list, ctx) => {
    const out = list.map(Number);
    if (out.some((n) => !Number.isFinite(n) || n <= 0 || n > 10)) {
      ctx.addIssue({ code: 'custom', message: 'thresholds must be fractions like 0.5,0.8,1.0' });
      return z.NEVER;
    }
    return [...out].sort((a, b) => a - b);
  }),
  HOMEPILOT_BASELINE_MODEL: z.string().optional().default('claude-opus-5-5'),

  HOMEPILOT_TIER_B_MODE: z.enum(['approve', 'auto']).optional().default('approve'),
  HOMEPILOT_APPROVAL_TTL_MINUTES: int(15, 1, 1440),

  HOMEPILOT_API_PORT: int(8787, 1024, 65_535),
  HOMEPILOT_API_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
});

export interface Config {
  dbPath: string;
  timezone: string;
  dryRun: boolean;
  allowedSenders: string[];
  /**
   * Channels where an AI agent relays the user's words (for example the OpenClaw skill).
   * Approvals and "resume" are refused on these: a model must never be able to say yes for you.
   */
  agentChannels: string[];
  nudges: {
    quietStart: string;
    quietEnd: string;
    maxPerDay: number;
    cooldownMinutes: number;
    intervalMinutes: number;
  };
  models: {
    provider: 'mock' | 'openrouter';
    openrouterApiKey: string | undefined;
    openrouterBaseUrl: string;
    fast: string[];
    balanced: string[];
    premium: string[];
    timeoutMs: number;
    maxRetries: number;
    maxConcurrency: number;
    maxOutputTokens: number;
  };
  budget: {
    monthlyUsd: number;
    alertThresholds: number[];
    baselineModel: string;
  };
  policy: {
    tierBMode: 'approve' | 'auto';
    approvalTtlMinutes: number;
  };
  api: {
    port: number;
    token: string | undefined;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid HomePilot configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validate configuration from an env-like object. Never logs values (they may be secrets). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    dbPath: e.HOMEPILOT_DB_PATH,
    timezone: e.HOMEPILOT_TIMEZONE,
    dryRun: e.HOMEPILOT_DRY_RUN,
    allowedSenders: e.HOMEPILOT_ALLOWED_SENDERS,
    agentChannels: e.HOMEPILOT_AGENT_CHANNELS,
    nudges: {
      quietStart: e.HOMEPILOT_QUIET_HOURS_START,
      quietEnd: e.HOMEPILOT_QUIET_HOURS_END,
      maxPerDay: e.HOMEPILOT_MAX_NUDGES_PER_DAY,
      cooldownMinutes: e.HOMEPILOT_NUDGE_COOLDOWN_MINUTES,
      intervalMinutes: e.HOMEPILOT_NUDGE_INTERVAL_MINUTES,
    },
    models: {
      provider: e.HOMEPILOT_MODEL_PROVIDER,
      openrouterApiKey: e.OPENROUTER_API_KEY || undefined,
      openrouterBaseUrl: e.OPENROUTER_BASE_URL,
      fast: e.HOMEPILOT_MODEL_FAST,
      balanced: e.HOMEPILOT_MODEL_BALANCED,
      premium: e.HOMEPILOT_MODEL_PREMIUM,
      timeoutMs: e.HOMEPILOT_LLM_TIMEOUT_MS,
      maxRetries: e.HOMEPILOT_LLM_MAX_RETRIES,
      maxConcurrency: e.HOMEPILOT_LLM_MAX_CONCURRENCY,
      maxOutputTokens: e.HOMEPILOT_LLM_MAX_OUTPUT_TOKENS,
    },
    budget: {
      monthlyUsd: e.HOMEPILOT_MONTHLY_BUDGET_USD,
      alertThresholds: e.HOMEPILOT_BUDGET_ALERT_THRESHOLDS,
      baselineModel: e.HOMEPILOT_BASELINE_MODEL,
    },
    policy: {
      tierBMode: e.HOMEPILOT_TIER_B_MODE,
      approvalTtlMinutes: e.HOMEPILOT_APPROVAL_TTL_MINUTES,
    },
    api: {
      port: e.HOMEPILOT_API_PORT,
      token: e.HOMEPILOT_API_TOKEN || undefined,
    },
  };
}

/** Load ./.env into process.env if present (values already in the environment win). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/** A config with safe defaults for tests and the demo. */
export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({ HOMEPILOT_DB_PATH: ':memory:', ...overrides });
}
