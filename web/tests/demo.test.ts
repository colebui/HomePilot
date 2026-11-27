import { describe, expect, it } from "vitest";
import { buildDemoSnapshot, createDemoSource } from "@/lib/homepilot/demo";
import {
  ActivitySchema,
  AgendaSchema,
  ApprovalsSchema,
  HealthSchema,
  InsightsSchema,
  RemindersSchema,
  SpendingSchema,
  TasksSchema,
  UsageReportSchema,
} from "@/lib/homepilot/schemas";

// Month start, mid-month, month end, and both US daylight-saving switches.
const MOMENTS = ["2026-11-01T06:30:00Z", "2026-11-16T15:00:00Z", "2026-11-30T23:59:00Z", "2026-03-08T09:00:00Z", "2026-11-01T08:30:00Z"];

describe("demo data", () => {
  it.each(MOMENTS)("matches the live API's shapes at %s", (iso) => {
    const s = buildDemoSnapshot(new Date(iso));
    HealthSchema.parse(s.health);
    UsageReportSchema.parse(s.usage);
    AgendaSchema.parse(s.agenda);
    TasksSchema.parse(s.tasks);
    ApprovalsSchema.parse(s.approvals);
    InsightsSchema.parse(s.insights);
    ActivitySchema.parse(s.activity);
    RemindersSchema.parse(s.reminders);
    SpendingSchema.parse(s.spending);
  });

  it.each(MOMENTS)("is internally consistent at %s", (iso) => {
    const s = buildDemoSnapshot(new Date(iso));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    // Personal: the daily bars add up to the month total, and so do the categories.
    expect(sum(s.spending.summary.daily.map((d) => d.totalUsd))).toBeCloseTo(s.spending.summary.totalUsd, 1);
    expect(sum(s.spending.summary.byCategory.map((c) => c.totalUsd))).toBeCloseTo(s.spending.summary.totalUsd, 1);
    // Model spend: per-model rows add up to the month's calls and cost.
    expect(sum(s.usage.byModel.map((m) => m.calls))).toBe(s.usage.calls.total);
    expect(sum(s.usage.byModel.map((m) => m.realCostUsd))).toBeCloseTo(s.usage.spend.thisMonth.providerReportedUsd, 10);
    expect(s.insights.texts.deterministic).toBeLessThanOrEqual(s.insights.texts.handled);
    // Nothing is dated in the future.
    const now = new Date(iso).getTime();
    expect(s.activity.every((a) => new Date(a.ts).getTime() <= now)).toBe(true);
    expect(s.spending.recent.every((e) => new Date(e.spentAt).getTime() <= now)).toBe(true);
  });

  it("is stable for the same moment", () => {
    expect(buildDemoSnapshot(new Date(MOMENTS[1]!))).toEqual(buildDemoSnapshot(new Date(MOMENTS[1]!)));
  });

  it("keeps a visitor's changes in memory only", async () => {
    const at = new Date(MOMENTS[1]!);
    const src = createDemoSource(() => at);
    const first = (await src.tasks())[0]!;
    await src.completeTask(first.id);
    expect((await src.tasks()).some((t) => t.id === first.id)).toBe(false);
    expect((await src.activity()).some((a) => a.kind === "task_completed" && a.title === first.title)).toBe(true);
    const expense = (await src.spending()).recent[0]!;
    await src.deleteExpense(expense.id);
    expect((await src.spending()).recent.some((e) => e.id === expense.id)).toBe(false);
    // A new source (a restart) starts clean.
    expect((await createDemoSource(() => at).tasks()).some((t) => t.id === first.id)).toBe(true);
  });

  it("answers commands without pretending anything was saved", async () => {
    const reply = await createDemoSource().say("spent $5 on coffee");
    expect(reply.reply).toMatch(/demo, so nothing was saved/);
  });
});
