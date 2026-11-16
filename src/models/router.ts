import type { z } from 'zod';
import type { Telemetry } from '../telemetry/usage.js';
import { ProviderError, type ErrorCategory, type ModelProvider, type TaskClass } from './types.js';

export interface ClassPolicy {
  /** Primary model first, then fallbacks, in order. */
  models: string[];
  timeoutMs: number;
  maxOutputTokens: number;
  /** Extra attempts per model after the first (so 1 means up to 2 tries per model). */
  maxRetries: number;
}

export interface RouterOptions {
  provider: ModelProvider;
  policy: Record<TaskClass, ClassPolicy>;
  telemetry: Telemetry;
  budget: {
    monthlyUsd: number;
    /** Count simulated (mock) spend toward the ceiling. Used by tests and the demo. */
    includeSimulated?: boolean;
  };
  maxConcurrency: number;
  /** Hard cap on attempts across all models for one request. */
  maxTotalAttempts?: number;
  /** Called after every recorded call so budget alerts can be raised. */
  onCallRecorded?: () => void;
}

export interface StructuredRequest<T> {
  taskClass: TaskClass;
  workflow: string;
  feature: string;
  correlationId: string;
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export type FailureReason = 'budget_exceeded' | 'all_models_failed' | 'no_models_configured';

export type StructuredResult<T> =
  | { ok: true; value: T; model: string; attempts: number; usedFallback: boolean }
  | { ok: false; reason: FailureReason; attempts: number; errors: { model: string; category: ErrorCategory | 'budget' }[] };

/** Pull the first JSON object out of model text (tolerates code fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('no JSON object found');
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Typed model router.
 *
 * - Picks models by task class, with ordered fallbacks.
 * - Validates output against a Zod schema; invalid output is retried within strict caps.
 * - Enforces a per-call timeout, a concurrency limit and a monthly spend ceiling.
 * - Records EVERY attempt (success, bad output, error, budget block) to telemetry.
 * - Never throws for model problems: returns { ok: false } so the caller takes its safe,
 *   deterministic fallback. It only ever returns data. Side effects are the caller's job and
 *   must go through the policy layer, so an inference retry can never repeat a side effect.
 */
export class ModelRouter {
  private readonly sem: Semaphore;
  private readonly maxTotalAttempts: number;

  constructor(private readonly opts: RouterOptions) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrency));
    this.maxTotalAttempts = opts.maxTotalAttempts ?? 6;
  }

  get providerName(): string {
    return this.opts.provider.name;
  }

  private overBudget(): boolean {
    const spent = this.opts.telemetry.monthSpendUsd({ includeSimulated: this.opts.budget.includeSimulated });
    return spent >= this.opts.budget.monthlyUsd;
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return this.sem.run(() => this.runStructured(req));
  }

  private async runStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const policy = this.opts.policy[req.taskClass];
    const { provider, telemetry } = this.opts;
    const errors: { model: string; category: ErrorCategory | 'budget' }[] = [];
    let attempts = 0;

    if (!policy || policy.models.length === 0) return { ok: false, reason: 'no_models_configured', attempts, errors };

    const base = {
      correlationId: req.correlationId,
      workflow: req.workflow,
      feature: req.feature,
      taskClass: req.taskClass,
      provider: provider.name,
      via: provider.via,
    };

    for (const [modelIndex, model] of policy.models.entries()) {
      for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
        if (attempts >= this.maxTotalAttempts) return { ok: false, reason: 'all_models_failed', attempts, errors };

        // Checked before every attempt, so a retry storm cannot blow through the ceiling.
        if (this.overBudget()) {
          telemetry.recordLlmCall({
            ...base,
            model,
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            latencyMs: 0,
            timedOut: false,
            attempt,
            isFallback: modelIndex > 0,
            outcome: 'blocked_budget',
            errorCategory: 'budget',
          });
          errors.push({ model, category: 'budget' });
          this.opts.onCallRecorded?.();
          return { ok: false, reason: 'budget_exceeded', attempts, errors };
        }

        attempts++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
        const started = performance.now(); // elapsed-time measurement, not "current time"
        try {
          const res = await provider.complete({
            model,
            system: req.system,
            prompt: req.prompt,
            maxOutputTokens: policy.maxOutputTokens,
            json: true,
            signal: controller.signal,
          });
          const latencyMs = performance.now() - started;

          let value: T | undefined;
          let valid = false;
          try {
            const parsed = req.schema.safeParse(extractJson(res.text));
            if (parsed.success) {
              value = parsed.data;
              valid = true;
            }
          } catch {
            valid = false;
          }

          telemetry.recordLlmCall({
            ...base,
            model: res.model,
            usage: res.usage,
            reportedCostUsd: res.reportedCostUsd,
            latencyMs,
            timedOut: false,
            attempt,
            isFallback: modelIndex > 0,
            outcome: valid ? 'ok' : 'invalid_output',
            errorCategory: valid ? undefined : 'invalid_output',
          });
          this.opts.onCallRecorded?.();

          if (valid) return { ok: true, value: value as T, model: res.model, attempts, usedFallback: modelIndex > 0 };
          errors.push({ model, category: 'invalid_output' });
          // Bad output still cost money; retry within the cap, then fall through to the next model.
        } catch (err) {
          const latencyMs = performance.now() - started;
          const pe =
            err instanceof ProviderError
              ? err
              : new ProviderError(err instanceof Error ? err.message : 'unknown provider failure', 'unknown', false);
          const timedOut = pe.category === 'timeout' || controller.signal.aborted;
          telemetry.recordLlmCall({
            ...base,
            model,
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            latencyMs,
            timedOut,
            attempt,
            isFallback: modelIndex > 0,
            outcome: 'error',
            errorCategory: timedOut ? 'timeout' : pe.category,
          });
          this.opts.onCallRecorded?.();
          errors.push({ model, category: timedOut ? 'timeout' : pe.category });

          // Credential and credit problems affect every model on this provider: stop now.
          if (pe.category === 'auth' || pe.category === 'insufficient_credits') {
            return { ok: false, reason: 'all_models_failed', attempts, errors };
          }
          if (!pe.retryable && !timedOut) break; // next model
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return { ok: false, reason: 'all_models_failed', attempts, errors };
  }
}
