export type TaskClass = 'fast' | 'balanced' | 'premium';

export type ErrorCategory =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'server'
  | 'network'
  | 'bad_request'
  | 'insufficient_credits'
  | 'invalid_output'
  | 'unknown';

export interface ModelRequest {
  model: string;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  /** Ask the provider for a JSON object response where supported. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ModelUsage {
  /** Total prompt tokens, INCLUDING any served from cache. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens read from the provider's prompt cache. */
  cachedTokens: number;
}

export interface ModelResponse {
  text: string;
  /** Exact model identifier the provider says served the request. */
  model: string;
  usage: ModelUsage;
  /** Amount the provider says it charged, in USD. Undefined when the provider does not report it. */
  reportedCostUsd?: number;
}

export interface ModelProvider {
  readonly name: string;
  /** How the request reached the model. 'mock' never leaves this machine. */
  readonly via: 'openrouter' | 'direct' | 'mock';
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly category: ErrorCategory,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
