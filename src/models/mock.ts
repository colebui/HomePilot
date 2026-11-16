import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from './types.js';

export type MockReply =
  | { text: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number; reportedCostUsd?: number }
  | { error: ProviderError }
  | { hangMs: number };

/**
 * Offline stand-in for a model provider. Nothing leaves the machine and nothing is billed.
 * Token counts it returns are SIMULATED (roughly 4 characters per token) and every call made
 * through it is recorded with cost_kind = 'simulated'.
 *
 * Replies come from, in order: a scripted queue, a per-model handler, then a default handler
 * that classifies the message as "unknown" so no action is ever taken on a guess.
 */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly via = 'mock' as const;
  readonly calls: ModelRequest[] = [];
  private queue: MockReply[] = [];
  private byModel = new Map<string, (req: ModelRequest) => MockReply>();
  private fallback: (req: ModelRequest) => MockReply = () => ({ text: JSON.stringify({ intent: 'unknown' }) });

  /** Script the next replies, consumed in order across all models. */
  enqueue(...replies: MockReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  onModel(model: string, handler: (req: ModelRequest) => MockReply): this {
    this.byModel.set(model, handler);
    return this;
  }

  setDefault(handler: (req: ModelRequest) => MockReply): this {
    this.fallback = handler;
    return this;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const reply = this.queue.shift() ?? this.byModel.get(req.model)?.(req) ?? this.fallback(req);

    if ('error' in reply) throw reply.error;
    if ('hangMs' in reply) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, reply.hangMs);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new ProviderError('request timed out', 'timeout', true));
        });
      });
      throw new ProviderError('mock hang finished without a response', 'timeout', true);
    }

    const approx = (s: string): number => Math.max(1, Math.ceil(s.length / 4));
    return {
      text: reply.text,
      model: req.model,
      usage: {
        inputTokens: reply.inputTokens ?? approx((req.system ?? '') + req.prompt),
        outputTokens: reply.outputTokens ?? approx(reply.text),
        cachedTokens: reply.cachedTokens ?? 0,
      },
      ...(reply.reportedCostUsd !== undefined ? { reportedCostUsd: reply.reportedCostUsd } : {}),
    };
  }
}
