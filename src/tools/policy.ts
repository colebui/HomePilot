import type { z } from 'zod';
import type { SystemState } from '../domain/preferences.js';

/**
 * Tier A: automatic once its scope is granted (read, analyze, internal records, rate-limited notices).
 * Tier B: ordinary reversible changes (calendar events, cart items). Approval is configurable.
 * Tier C: money, bookings, messages to other people, sharing private data, destructive changes.
 *         ALWAYS needs an action-specific approval. No setting can turn that off.
 */
export type Tier = 'A' | 'B' | 'C';

/**
 * Where a proposed tool call came from.
 * - user: the allowlisted person, through an authenticated channel.
 * - system: HomePilot's own deterministic code (scheduler, rules).
 * - untrusted_content: derived from a web page, listing, email, calendar invite or any other
 *   third-party text. Such content is DATA. It can never authorize or trigger a tool call.
 */
export type Origin = 'user' | 'system' | 'untrusted_content';

export interface ActionSummary {
  /** The exact proposed action in plain words. */
  action: string;
  target?: string;
  priceUsd?: number;
}

export interface ToolContext {
  correlationId: string | null;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  tier: Tier;
  /** Permission scope that must be granted before this tool can run at all. */
  scope: string;
  description: string;
  /** false = only touches HomePilot's own database. true = affects the outside world. */
  external: boolean;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  summarize(input: I): ActionSummary;
  /** Describe what WOULD happen. Must have no side effects. */
  dryRun(input: I, ctx: ToolContext): Promise<O> | O;
  /** Perform the action. Omitted when no real integration exists yet. */
  execute?: (input: I, ctx: ToolContext) => Promise<O> | O;
  /** Confirm the provider really did it, before the action is recorded as complete. */
  verify?: (output: O) => boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register<I, O>(tool: ToolDef<I, O>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDef);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export type DenyCode =
  | 'unknown_tool'
  | 'invalid_input'
  | 'paused'
  | 'untrusted_origin'
  | 'scope_not_granted'
  | 'approval_denied'
  | 'approval_expired'
  | 'approval_mismatch'
  | 'approval_not_found'
  | 'approval_already_used';

export type PolicyDecision =
  | { effect: 'allow'; reason: string }
  | { effect: 'needs_approval'; reason: string }
  | { effect: 'deny'; code: DenyCode; reason: string };

const SCOPE_PREFIX = 'scope:';

/** Scopes that only touch HomePilot's own data and are on from the start. */
export const DEFAULT_SCOPES = ['tasks.write', 'notify.send'];

/**
 * The policy engine. Plain code, no model involved. Default is DENY: anything not explicitly
 * permitted by a rule below is refused.
 */
export class PolicyEngine {
  constructor(
    private readonly system: SystemState,
    private readonly cfg: { tierBMode: 'approve' | 'auto' },
  ) {}

  /** Seed default scopes without re-granting anything the user has revoked. */
  seedDefaults(): void {
    for (const scope of DEFAULT_SCOPES) this.system.setOnce(SCOPE_PREFIX + scope, 'granted');
  }

  grant(scope: string): void {
    this.system.set(SCOPE_PREFIX + scope, 'granted');
  }

  revoke(scope: string): void {
    this.system.set(SCOPE_PREFIX + scope, 'revoked');
  }

  isGranted(scope: string): boolean {
    return this.system.get(SCOPE_PREFIX + scope) === 'granted';
  }

  evaluate(tool: Pick<ToolDef, 'name' | 'tier' | 'scope'>, origin: Origin): PolicyDecision {
    if (this.system.isPaused()) {
      return { effect: 'deny', code: 'paused', reason: 'HomePilot is paused (kill switch is on)' };
    }
    if (origin === 'untrusted_content') {
      return {
        effect: 'deny',
        code: 'untrusted_origin',
        reason: 'the request came from third-party content, which cannot trigger actions',
      };
    }
    if (origin !== 'user' && origin !== 'system') {
      return { effect: 'deny', code: 'untrusted_origin', reason: 'unknown request origin' };
    }
    if (!this.isGranted(tool.scope)) {
      return { effect: 'deny', code: 'scope_not_granted', reason: `permission "${tool.scope}" has not been granted` };
    }
    switch (tool.tier) {
      case 'A':
        return { effect: 'allow', reason: 'tier A: automatic within a granted scope' };
      case 'B':
        return this.cfg.tierBMode === 'auto'
          ? { effect: 'allow', reason: 'tier B: auto-approved by your setting' }
          : { effect: 'needs_approval', reason: 'tier B: needs your approval' };
      case 'C':
        return { effect: 'needs_approval', reason: 'tier C: always needs approval for this exact action' };
      default:
        return { effect: 'deny', code: 'unknown_tool', reason: 'unrecognized tier' };
    }
  }
}
