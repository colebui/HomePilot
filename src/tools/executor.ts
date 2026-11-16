import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import type { Approval, ApprovalStore } from '../domain/approvals.js';
import type { EventLog } from '../domain/events.js';
import { actionHash, newId } from '../ids.js';
import type { Notifier } from '../notify/notifier.js';
import { formatLocal } from '../time.js';
import type { DenyCode, Origin, PolicyEngine, ToolRegistry } from './policy.js';

export type ExecResult =
  | { status: 'succeeded'; mode: 'dry_run' | 'live'; output: unknown; executionId: string; replayed: boolean }
  | { status: 'awaiting_approval'; approval: Approval }
  | { status: 'denied'; code: DenyCode; reason: string }
  | { status: 'failed'; error: string; executionId?: string; replayed?: boolean };

export interface ExecRequest {
  tool: string;
  input: unknown;
  origin: Origin;
  /** Same key = same logical action. A repeat returns the stored result instead of acting twice. */
  idempotencyKey: string;
  /** Optional explicit approval to use. It must match this exact action. */
  approvalId?: string;
  correlationId?: string | null;
}

interface ExecutionRow {
  id: string;
  mode: 'dry_run' | 'live';
  status: 'succeeded' | 'failed';
  result: string;
  action_hash: string;
}

/**
 * The only path by which a tool may run. Order of checks:
 *   known tool -> valid input -> idempotent replay -> policy -> approval -> run -> verify -> audit.
 * A model can propose a call; it cannot skip any of these steps.
 */
export class ToolExecutor {
  constructor(
    private readonly deps: {
      db: Db;
      clock: Clock;
      registry: ToolRegistry;
      policy: PolicyEngine;
      approvals: ApprovalStore;
      events: EventLog;
      notifier: Notifier;
      dryRun: boolean;
      approvalTtlMinutes: number;
      timezone: string;
    },
  ) {}

  private audit(kind: string, req: ExecRequest, data: Record<string, unknown>): void {
    this.deps.events.record({
      kind,
      actor: req.origin,
      correlationId: req.correlationId ?? null,
      subjectType: 'tool',
      subjectId: req.tool,
      data: { idempotencyKey: req.idempotencyKey, ...data },
    });
  }

  private deny(req: ExecRequest, code: DenyCode, reason: string): ExecResult {
    this.audit('tool.denied', req, { code, reason });
    return { status: 'denied', code, reason };
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const { registry, policy, approvals, db, clock } = this.deps;

    const tool = registry.get(req.tool);
    if (!tool) return this.deny(req, 'unknown_tool', `no tool named "${req.tool}" is registered`);

    const parsed = tool.input.safeParse(req.input);
    if (!parsed.success) {
      return this.deny(req, 'invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const input = parsed.data;
    const hash = actionHash(tool.name, input);

    // Idempotent replay: this exact logical action already ran. Never run it twice.
    const prior = db.get<ExecutionRow>('SELECT * FROM tool_executions WHERE idempotency_key = ?', req.idempotencyKey);
    if (prior) {
      if (prior.action_hash !== hash) {
        return this.deny(req, 'approval_mismatch', 'this idempotency key was already used for a different action');
      }
      this.audit('tool.replayed', req, { executionId: prior.id });
      return prior.status === 'succeeded'
        ? { status: 'succeeded', mode: prior.mode, output: JSON.parse(prior.result), executionId: prior.id, replayed: true }
        : { status: 'failed', error: String((JSON.parse(prior.result) as { error?: string }).error ?? 'failed'), executionId: prior.id, replayed: true };
    }

    const decision = policy.evaluate(tool, req.origin);
    if (decision.effect === 'deny') return this.deny(req, decision.code, decision.reason);

    let approvalId: string | undefined;
    if (decision.effect === 'needs_approval') {
      const summary = tool.summarize(input);
      let approval: Approval | undefined;

      if (req.approvalId) {
        approval = approvals.get(req.approvalId);
        if (!approval) return this.deny(req, 'approval_not_found', 'that approval does not exist');
      } else {
        const r = approvals.request({
          tool: tool.name,
          tier: tool.tier as 'B' | 'C',
          args: input,
          action: summary.action,
          target: summary.target,
          priceUsd: summary.priceUsd,
          idempotencyKey: req.idempotencyKey,
          correlationId: req.correlationId ?? null,
          ttlMinutes: this.deps.approvalTtlMinutes,
        });
        approval = r.approval;
        if (r.created) {
          const price = approval.priceUsd !== null ? ` for $${approval.priceUsd.toFixed(2)}` : '';
          const target = approval.target ? ` (${approval.target})` : '';
          this.deps.notifier.enqueue({
            dedupeKey: `approval:${approval.id}`,
            kind: 'approval',
            body:
              `Approval needed: ${approval.action}${target}${price}. ` +
              `Reply "approve ${approval.code}" or "deny ${approval.code}". ` +
              `Expires ${formatLocal(approval.expiresAt, this.deps.timezone)}.` +
              (this.deps.dryRun && tool.external ? ' (Dry-run: approving will only simulate it.)' : ''),
            reason: decision.reason,
            actions: [`approve ${approval.code}`, `deny ${approval.code}`],
            correlationId: req.correlationId ?? null,
          });
          this.audit('approval.requested', req, { approvalId: approval.id, tier: tool.tier, action: approval.action });
        }
      }

      // The approval must be for THIS action. A "yes" to something else never carries over.
      if (approval.actionHash !== hash || approval.tool !== tool.name) {
        return this.deny(req, 'approval_mismatch', 'the approval is for a different action');
      }
      switch (approval.state) {
        case 'pending':
          return { status: 'awaiting_approval', approval };
        case 'denied':
          return this.deny(req, 'approval_denied', 'you denied this action');
        case 'expired':
          return this.deny(req, 'approval_expired', 'the approval expired before it was used');
        case 'consumed':
          return this.deny(req, 'approval_already_used', 'this approval was already used');
        case 'approved':
          if (!approvals.consume(approval.id, hash)) {
            return this.deny(req, 'approval_expired', 'the approval could not be used (expired or already used)');
          }
          approvalId = approval.id;
          this.audit('approval.consumed', req, { approvalId: approval.id });
          break;
      }
    }

    // Internal tools always run for real; external tools obey dry-run.
    const mode: 'dry_run' | 'live' = tool.external && this.deps.dryRun ? 'dry_run' : 'live';
    const executionId = newId('exe');
    const ctx = { correlationId: req.correlationId ?? null };
    let status: 'succeeded' | 'failed' = 'succeeded';
    let output: unknown;
    let error: string | undefined;

    try {
      if (mode === 'dry_run') {
        output = await tool.dryRun(input, ctx);
      } else if (!tool.execute) {
        throw new Error(`"${tool.name}" has no live integration yet (not implemented); nothing was done`);
      } else {
        output = await tool.execute(input, ctx);
        if (tool.verify && !tool.verify(output)) {
          throw new Error('the provider did not confirm the action, so it is NOT recorded as done');
        }
      }
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }

    db.run(
      `INSERT INTO tool_executions (id, idempotency_key, tool, tier, action_hash, mode, status, result, approval_id, correlation_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      executionId,
      req.idempotencyKey,
      tool.name,
      tool.tier,
      hash,
      mode,
      status,
      JSON.stringify(status === 'succeeded' ? (output ?? null) : { error }),
      approvalId ?? null,
      req.correlationId ?? null,
      clock.now().toISOString(),
    );
    this.audit(status === 'succeeded' ? 'tool.executed' : 'tool.failed', req, { executionId, mode, tier: tool.tier, approvalId, error });

    return status === 'succeeded'
      ? { status: 'succeeded', mode, output, executionId, replayed: false }
      : { status: 'failed', error: error ?? 'failed', executionId };
  }

  /** Run the exact action an approval was created for, using the arguments stored with it. */
  async resume(approvalId: string, origin: Origin = 'user'): Promise<ExecResult> {
    const approval = this.deps.approvals.get(approvalId);
    if (!approval) {
      return { status: 'denied', code: 'approval_not_found', reason: 'that approval does not exist' };
    }
    return this.run({
      tool: approval.tool,
      input: approval.args,
      origin,
      idempotencyKey: approval.idempotencyKey,
      approvalId: approval.id,
      correlationId: approval.correlationId,
    });
  }
}
