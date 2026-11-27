import { z } from "zod";

/**
 * Schemas for the HomePilot service's local JSON API. Every response is parsed with these before
 * it reaches a component, so a change on the service side fails loudly here instead of rendering
 * wrong numbers. `tests/contract.test.ts` checks them against real responses from the service.
 *
 * Unknown keys are stripped (zod's default), so the service can add fields without breaking the UI.
 */

const isoDate = z.iso.datetime({ offset: true });

export const HealthSchema = z.object({
  ok: z.boolean(),
  time: isoDate,
  timezone: z.string(),
  paused: z.boolean(),
  dryRun: z.boolean(),
  jobs: z.record(z.string(), z.number()),
  notificationsQueued: z.number(),
  pendingApprovals: z.number(),
  openTasks: z.number(),
  lastTickAt: isoDate.nullable(),
  modelProvider: z.object({ name: z.string(), live: z.boolean() }),
  channel: z.object({ name: z.string(), live: z.boolean() }),
  calendar: z.object({ name: z.string(), connected: z.boolean() }),
  problems: z.array(z.string()),
});

const SpendSplitSchema = z.object({
  providerReportedUsd: z.number(),
  estimatedUsd: z.number(),
  simulatedUsd: z.number(),
});

const GroupRowSchema = z.object({
  key: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedTokens: z.number(),
  realCostUsd: z.number(),
  simulatedCostUsd: z.number(),
});

export const UsageReportSchema = z.object({
  generatedAt: isoDate,
  timezone: z.string(),
  containsSimulatedData: z.boolean(),
  spend: z.object({ today: SpendSplitSchema, last7Days: SpendSplitSchema, thisMonth: SpendSplitSchema }),
  byModel: z.array(GroupRowSchema),
  byFeature: z.array(GroupRowSchema),
  calls: z.object({
    total: z.number(),
    ok: z.number(),
    invalidOutput: z.number(),
    errors: z.number(),
    blockedByBudget: z.number(),
    timeouts: z.number(),
    retries: z.number(),
    fallbacks: z.number(),
    avgLatencyMs: z.number().nullable(),
  }),
  workflows: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    unfinished: z.number(),
    failureRate: z.number().nullable(),
    deterministic: z.number(),
    usedModel: z.number(),
    costPerSuccessfulWorkflowUsd: z.number().nullable(),
  }),
  baseline: z.object({
    model: z.string(),
    priceDate: z.string(),
    hypotheticalClaudeOnlyUsd: z.number(),
    actualUsd: z.number(),
    differenceUsd: z.number(),
    differencePct: z.number().nullable(),
    basis: z.string(),
    caveats: z.array(z.string()),
  }),
  budget: z.object({
    monthlyUsd: z.number(),
    usedUsd: z.number(),
    usedFraction: z.number().nullable(),
    thresholds: z.array(z.object({ at: z.number(), crossed: z.boolean() })),
  }),
});

export const AgendaSchema = z.array(
  z.object({
    label: z.string(),
    items: z.array(z.object({ id: z.string(), title: z.string(), time: z.string(), note: z.string().optional() })),
  }),
);

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  state: z.enum(["open", "snoozed", "done", "dismissed"]),
  priority: z.number().int().min(1).max(4),
  dueAt: isoDate.nullable(),
  windowStart: isoDate.nullable(),
  windowEnd: isoDate.nullable(),
  snoozeUntil: isoDate.nullable(),
  location: z.string().nullable(),
  doNotRemind: z.boolean(),
  createdAt: isoDate,
});
export const TasksSchema = z.array(TaskSchema);

export const ApprovalSchema = z.object({
  id: z.string(),
  code: z.string(),
  tool: z.string(),
  tier: z.enum(["B", "C"]),
  action: z.string(),
  target: z.string().nullable(),
  priceUsd: z.number().nullable(),
  state: z.enum(["pending", "approved", "denied", "expired", "consumed"]),
  requestedAt: isoDate,
  expiresAt: isoDate,
});
export const ApprovalsSchema = z.array(ApprovalSchema);

export const InsightsSchema = z.object({
  generatedAt: isoDate,
  timezone: z.string(),
  today: z.object({
    tasksAdded: z.number(),
    tasksCompleted: z.number(),
    remindersSent: z.number(),
    textsHandled: z.number(),
  }),
  dailySpend: z.array(
    z.object({
      date: z.iso.date(),
      realUsd: z.number(),
      simulatedUsd: z.number(),
      calls: z.number(),
    }),
  ),
  projectedMonthUsd: z.number().nullable(),
  latency: z.object({
    overall: z.object({
      calls: z.number(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
      failureRate: z.number().nullable(),
    }),
    byModel: z.array(
      z.object({
        model: z.string(),
        calls: z.number(),
        p50Ms: z.number().nullable(),
        p95Ms: z.number().nullable(),
        failureRate: z.number().nullable(),
      }),
    ),
  }),
  texts: z.object({
    handled: z.number(),
    deterministic: z.number(),
    usedModel: z.number(),
    notUnderstood: z.number(),
  }),
});

export const ActivityKindSchema = z.enum([
  "task_added",
  "task_completed",
  "task_snoozed",
  "task_dismissed",
  "reminder_sent",
  "nudge_sent",
  "text_handled",
  "text_not_understood",
  "paused",
  "resumed",
  "budget_alert",
  "expense_logged",
  "approval",
  "problem",
]);

export const ActivitySchema = z.array(
  z.object({
    id: z.string(),
    ts: isoDate,
    kind: ActivityKindSchema,
    title: z.string(),
    detail: z.string().nullable(),
  }),
);

export const RemindersSchema = z.array(
  z.object({ id: z.string(), taskId: z.string(), title: z.string(), fireAt: isoDate }),
);

export const SayResultSchema = z.object({
  authorized: z.boolean(),
  reply: z.string().nullable(),
  understoodBy: z.enum(["deterministic", "model", "not_understood", "rejected"]),
  model: z.string().optional(),
  command: z.string().optional(),
});

export type Health = z.infer<typeof HealthSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
export type Agenda = z.infer<typeof AgendaSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Insights = z.infer<typeof InsightsSchema>;
export type ActivityKind = z.infer<typeof ActivityKindSchema>;
export type ActivityItem = z.infer<typeof ActivitySchema>[number];
export type UpcomingReminder = z.infer<typeof RemindersSchema>[number];
export type SayResult = z.infer<typeof SayResultSchema>;

export const CATEGORIES = ["groceries", "dining", "transport", "shopping", "bills", "health", "entertainment", "other"] as const;
export const CategorySchema = z.enum(CATEGORIES);

export const ExpenseSchema = z.object({
  id: z.string(),
  spentAt: isoDate,
  amountUsd: z.number().positive(),
  merchant: z.string().nullable(),
  category: CategorySchema,
  note: z.string().nullable(),
});

export const SpendingSchema = z.object({
  budgetUsd: z.number().min(0),
  summary: z.object({
    monthStart: isoDate,
    totalUsd: z.number(),
    count: z.number(),
    byCategory: z.array(z.object({ category: CategorySchema, totalUsd: z.number(), count: z.number() })),
    topMerchants: z.array(z.object({ merchant: z.string(), totalUsd: z.number(), count: z.number() })),
    lastMonthSameDaysUsd: z.number(),
    daily: z.array(z.object({ date: z.iso.date(), totalUsd: z.number(), billsUsd: z.number() })),
  }),
  recent: z.array(ExpenseSchema),
});

export type Category = z.infer<typeof CategorySchema>;
export type Expense = z.infer<typeof ExpenseSchema>;
export type Spending = z.infer<typeof SpendingSchema>;
