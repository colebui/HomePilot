import type { Insights, Spending, UsageReport } from "./homepilot/schemas";

/**
 * Derived numbers for the Spending page. Kept out of components so they are tested, and so the
 * Today card and the Spending page always agree.
 */

export type PaceStatus = "on_track" | "watch" | "over";

export function realSpend(s: UsageReport["spend"]["thisMonth"]): number {
  return s.providerReportedUsd + s.estimatedUsd;
}

export function paceStatus(usedFraction: number, projectedFraction: number | null): PaceStatus {
  if (usedFraction >= 1 || (projectedFraction ?? 0) >= 1) return "over";
  if ((projectedFraction ?? usedFraction) >= 0.8) return "watch";
  return "on_track";
}

export const PACE_LABEL: Record<PaceStatus, string> = {
  on_track: "On track",
  watch: "Close to budget",
  over: "Over budget",
};

export const PACE_TONE: Record<PaceStatus, "good" | "warning" | "critical"> = {
  on_track: "good",
  watch: "warning",
  over: "critical",
};

export interface ModelCostSummary {
  monthUsd: number;
  budgetUsd: number;
  usedFraction: number;
  projectedUsd: number | null;
  projectedFraction: number | null;
  status: PaceStatus;
  /** Model spend this month divided by texts handled this month. */
  costPerTextUsd: number | null;
  /** Share of this month's texts understood without any model call. */
  freeShare: number | null;
  hypotheticalUsd: number;
  savedFraction: number | null;
}

export function summarizeModelCost(usage: UsageReport, insights: Insights): ModelCostSummary {
  const monthUsd = realSpend(usage.spend.thisMonth);
  const budgetUsd = usage.budget.monthlyUsd;
  const usedFraction = budgetUsd > 0 ? monthUsd / budgetUsd : 0;
  const projectedUsd = insights.projectedMonthUsd;
  const projectedFraction = projectedUsd !== null && budgetUsd > 0 ? projectedUsd / budgetUsd : null;
  const handled = insights.texts.handled;
  return {
    monthUsd,
    budgetUsd,
    usedFraction,
    projectedUsd,
    projectedFraction,
    status: paceStatus(usedFraction, projectedFraction),
    costPerTextUsd: handled > 0 ? monthUsd / handled : null,
    freeShare: handled > 0 ? insights.texts.deterministic / handled : null,
    hypotheticalUsd: usage.baseline.hypotheticalClaudeOnlyUsd,
    savedFraction: usage.baseline.differencePct === null ? null : usage.baseline.differencePct / 100,
  };
}

export interface PersonalSpendSummary {
  totalUsd: number;
  budgetUsd: number;
  usedFraction: number | null;
  /** Straight-line month-end projection from the pace so far. */
  projectedUsd: number | null;
  projectedFraction: number | null;
  status: PaceStatus | null;
  /** This month minus the same days last month; null when last month has nothing to compare. */
  vsLastMonthUsd: number | null;
  vsLastMonthFraction: number | null;
}

export function summarizePersonal(spending: Spending, now: Date, timeZone: string): PersonalSpendSummary {
  const { summary, budgetUsd } = spending;
  const dayOfMonth = Number(new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(now));
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(now).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const projectedUsd = summary.totalUsd > 0 ? (summary.totalUsd / dayOfMonth) * daysInMonth : null;
  const usedFraction = budgetUsd > 0 ? summary.totalUsd / budgetUsd : null;
  const projectedFraction = projectedUsd !== null && budgetUsd > 0 ? projectedUsd / budgetUsd : null;
  const last = summary.lastMonthSameDaysUsd;
  return {
    totalUsd: summary.totalUsd,
    budgetUsd,
    usedFraction,
    projectedUsd,
    projectedFraction,
    status: usedFraction === null ? null : paceStatus(usedFraction, projectedFraction),
    vsLastMonthUsd: last > 0 ? summary.totalUsd - last : null,
    vsLastMonthFraction: last > 0 ? (summary.totalUsd - last) / last : null,
  };
}
