import { DateTime } from "luxon";
import type { HomePilotSource } from "./source";
import type {
  ActivityItem,
  Agenda,
  Approval,
  Category,
  Expense,
  Spending,
  Health,
  Insights,
  Task,
  UpcomingReminder,
  UsageReport,
} from "./schemas";

/**
 * Made-up data for the public demo. Every value is generated from the clock and a fixed seed, so
 * the demo looks lived-in on any day and nothing personal is ever involved. Shapes are the same as
 * the live API's (tests parse this data with the same schemas), and the numbers are internally
 * consistent: the daily spend chart, the month totals and the per-model table come from one list
 * of synthetic model calls.
 */

export const DEMO_TIMEZONE = "America/Chicago";

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoCall {
  ts: DateTime;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: "ok" | "error" | "invalid_output";
  isFallback: boolean;
  attempt: number;
}

interface DemoText {
  ts: DateTime;
  usedModel: boolean;
  understood: boolean;
  label: string;
}

const MODELS = {
  fast: { id: "deepseek/deepseek-v4.1-flash-1017", inPerM: 0.15, outPerM: 0.6, p50: 650 },
  balanced: { id: "google/gemini-4-hydrogen", inPerM: 1.5, outPerM: 7.5, p50: 1150 },
  fallback: { id: "tencent/hy4-flash", inPerM: 0.035, outPerM: 0.1405, p50: 900 },
} as const;

/** Claude API list prices used for the hypothetical comparison (USD per million tokens). */
const BASELINE = { model: "claude-opus-5-5", inPerM: 4, outPerM: 20, priceDate: "2026-11-03" };

const TEXT_LABELS = [
  "Added a task",
  "Added a task",
  "Added a task",
  "Sent the task list",
  "Marked a task done",
  "Snoozed a task",
  "Noted a task was started",
  "Handled several requests",
  "Sent a status report",
];

function generateHistory(now: DateTime): { calls: DemoCall[]; texts: DemoText[] } {
  const calls: DemoCall[] = [];
  const texts: DemoText[] = [];
  const today = now.startOf("day");
  for (let d = 44; d >= 0; d--) {
    const day = today.minus({ days: d });
    const rand = rng(Number(day.toFormat("yyyyLLdd")));
    const weekend = day.weekday >= 6;
    const nTexts = Math.floor((weekend ? 4 : 7) + rand() * 7);
    for (let i = 0; i < nTexts; i++) {
      const ts = day.plus({ minutes: Math.floor(7 * 60 + rand() * 15 * 60) });
      if (ts > now) continue;
      // Most texts are read by the deterministic parser and cost nothing.
      const usedModel = rand() < 0.16;
      const understood = !usedModel || rand() < 0.9;
      texts.push({ ts, usedModel, understood, label: TEXT_LABELS[Math.floor(rand() * TEXT_LABELS.length)]! });
      if (usedModel) {
        const failed = rand() < 0.04;
        const input = Math.floor(900 + rand() * 700);
        const output = Math.floor(40 + rand() * 80);
        const m = MODELS.fast;
        calls.push({
          ts,
          model: m.id,
          feature: "intent",
          inputTokens: input,
          outputTokens: output,
          costUsd: (input * m.inPerM + output * m.outPerM) / 1e6,
          latencyMs: Math.round(m.p50 * (0.6 + rand() * 0.9) + (rand() < 0.08 ? 1400 : 0)),
          outcome: failed ? "error" : "ok",
          isFallback: false,
          attempt: 1,
        });
        if (failed) {
          const f = MODELS.fallback;
          calls.push({
            ts: ts.plus({ seconds: 2 }),
            model: f.id,
            feature: "intent",
            inputTokens: input,
            outputTokens: output,
            costUsd: (input * f.inPerM + output * f.outPerM) / 1e6,
            latencyMs: Math.round(f.p50 * (0.7 + rand() * 0.8)),
            outcome: "ok",
            isFallback: true,
            attempt: 2,
          });
        }
      }
    }
    // "What should I do with my free hour?" style questions go to a stronger model, a few times a week.
    if (rand() < 0.35) {
      const ts = day.plus({ hours: 12 + Math.floor(rand() * 6) });
      if (ts <= now) {
        const m = MODELS.balanced;
        const input = Math.floor(2200 + rand() * 1500);
        const output = Math.floor(180 + rand() * 220);
        texts.push({ ts, usedModel: true, understood: true, label: "Suggested what to do next" });
        calls.push({
          ts,
          model: m.id,
          feature: "suggest",
          inputTokens: input,
          outputTokens: output,
          costUsd: (input * m.inPerM + output * m.outPerM) / 1e6,
          latencyMs: Math.round(m.p50 * (0.7 + rand() * 1.1)),
          outcome: rand() < 0.03 ? "invalid_output" : "ok",
          isFallback: false,
          attempt: 1,
        });
      }
    }
  }
  return { calls, texts: texts.sort((a, b) => a.ts.toMillis() - b.ts.toMillis()) };
}

const EXPENSE_PATTERNS: Array<{ category: Category; merchants: string[]; perWeek: number; min: number; max: number; note?: string }> = [
  { category: "groceries", merchants: ["H-E-B", "Costco", "Trader Joe's"], perWeek: 2.2, min: 24, max: 135 },
  { category: "dining", merchants: ["Chipotle", "the taco place", "Starbucks", "Pho Saigon"], perWeek: 4.5, min: 5.5, max: 38, note: "lunch" },
  { category: "transport", merchants: ["Shell", "Buc-ee's"], perWeek: 1, min: 34, max: 58, note: "gas" },
  { category: "shopping", merchants: ["Target", "Amazon"], perWeek: 0.9, min: 18, max: 95 },
  { category: "entertainment", merchants: ["Alamo Drafthouse", "Steam"], perWeek: 0.35, min: 12, max: 45 },
  { category: "health", merchants: ["CVS"], perWeek: 0.25, min: 9, max: 32 },
];

const MONTHLY_BILLS: Array<{ day: number; amount: number; merchant: string | null; note: string }> = [
  { day: 1, amount: 1450, merchant: null, note: "rent" },
  { day: 8, amount: 96.4, merchant: null, note: "electric bill" },
  { day: 12, amount: 15.49, merchant: "Netflix", note: "subscription" },
  { day: 15, amount: 65, merchant: null, note: "internet bill" },
];

function generateExpenses(now: DateTime): Expense[] {
  const out: Expense[] = [];
  const today = now.startOf("day");
  for (let d = 70; d >= 0; d--) {
    const day = today.minus({ days: d });
    const rand = rng(Number(day.toFormat("yyyyLLdd")) * 7 + 3);
    let n = 0;
    const push = (category: Category, amount: number, merchant: string | null, note: string | null, hour: number) => {
      const spentAt = day.set({ hour, minute: Math.floor(rand() * 60) });
      if (spentAt > now) return;
      out.push({ id: `exp_demo_${day.toFormat("yyyyLLdd")}_${n++}`, spentAt: spentAt.toUTC().toISO()!, amountUsd: Math.round(amount * 100) / 100, merchant, category, note });
    };
    for (const b of MONTHLY_BILLS) if (day.day === b.day) push(b.note.includes("bill") || b.note === "rent" ? "bills" : "entertainment", b.amount, b.merchant, b.note, 9);
    for (const p of EXPENSE_PATTERNS) {
      const weekendBoost = day.weekday >= 6 && (p.category === "dining" || p.category === "entertainment") ? 1.6 : 1;
      if (rand() < (p.perWeek / 7) * weekendBoost) {
        push(p.category, p.min + rand() * (p.max - p.min), p.merchants[Math.floor(rand() * p.merchants.length)]!, p.note ?? null, 10 + Math.floor(rand() * 10));
      }
    }
  }
  return out.sort((a, b) => (a.spentAt < b.spentAt ? 1 : -1));
}

function spendingFor(expenses: Expense[], now: DateTime): Spending {
  const monthStart = now.startOf("month");
  const inMonth = expenses.filter((e) => DateTime.fromISO(e.spentAt) >= monthStart);
  const round = (n: number) => Math.round(n * 100) / 100;
  const total = (xs: Expense[]) => round(xs.reduce((s, e) => s + e.amountUsd, 0));
  const lastStart = monthStart.minus({ months: 1 });
  const lastEnd = lastStart.plus({ days: now.day });
  const daily: Spending["summary"]["daily"] = [];
  for (let d = monthStart; d <= now; d = d.plus({ days: 1 })) {
    const onDay = inMonth.filter((e) => DateTime.fromISO(e.spentAt, { zone: now.zone }).hasSame(d, "day"));
    daily.push({ date: d.toISODate()!, totalUsd: total(onDay), billsUsd: total(onDay.filter((e) => e.category === "bills")) });
  }
  return {
    budgetUsd: 3800,
    summary: {
      monthStart: monthStart.toUTC().toISO()!,
      totalUsd: total(inMonth),
      count: inMonth.length,
      byCategory: [...Map.groupBy(inMonth, (e) => e.category).entries()]
        .map(([category, xs]) => ({ category, totalUsd: total(xs), count: xs.length }))
        .sort((a, b) => b.totalUsd - a.totalUsd),
      topMerchants: [...Map.groupBy(inMonth.filter((e) => e.merchant), (e) => e.merchant!).entries()]
        .map(([merchant, xs]) => ({ merchant, totalUsd: total(xs), count: xs.length }))
        .sort((a, b) => b.totalUsd - a.totalUsd)
        .slice(0, 5),
      lastMonthSameDaysUsd: total(expenses.filter((e) => {
        const t = DateTime.fromISO(e.spentAt);
        return t >= lastStart && t < lastEnd;
      })),
      daily,
    },
    recent: expenses.slice(0, 25),
  };
}

interface DemoTaskDef {
  title: string;
  dayOffset: number | null;
  /** "HH:mm" local, or "window" for "sometime that day", or "eod" for "by end of day". */
  at: string;
  priority?: number;
  location?: string;
}

const TASKS: DemoTaskDef[] = [
  { title: "Renew car registration", dayOffset: -1, at: "17:00", priority: 3 },
  { title: "Call the dentist to reschedule", dayOffset: 0, at: "10:30" },
  { title: "Pick up dry cleaning", dayOffset: 0, at: "17:30", location: "Main St" },
  { title: "Take the recycling out", dayOffset: 0, at: "20:00" },
  { title: "Pay the water bill", dayOffset: 1, at: "window", priority: 3 },
  { title: "Book flights for the holidays", dayOffset: 1, at: "12:00" },
  { title: "Get a haircut", dayOffset: 3, at: "eod" },
  { title: "Return the library books", dayOffset: 4, at: "16:00" },
  { title: "Send the rent payment", dayOffset: 5, at: "09:00", priority: 4 },
  { title: "Look into a new gym", dayOffset: null, at: "window", priority: 1 },
];

function buildTasks(now: DateTime): Task[] {
  const today = now.startOf("day");
  return TASKS.map((t, i) => {
    const id = `task_demo_${String(i + 1).padStart(2, "0")}`;
    const created = now.minus({ days: 2, hours: i });
    let dueAt: string | null = null;
    let windowStart: string | null = null;
    let windowEnd: string | null = null;
    if (t.dayOffset !== null) {
      const day = today.plus({ days: t.dayOffset });
      if (t.at === "window" || t.at === "eod") {
        windowStart = (t.at === "eod" ? today : day).toUTC().toISO();
        windowEnd = day.endOf("day").toUTC().toISO();
      } else {
        const [h, m] = t.at.split(":").map(Number);
        dueAt = day.set({ hour: h, minute: m }).toUTC().toISO();
      }
    }
    return {
      id,
      title: t.title,
      category: null,
      state: "open" as const,
      priority: t.priority ?? 2,
      dueAt,
      windowStart,
      windowEnd,
      snoozeUntil: null,
      location: t.location ?? null,
      doNotRemind: false,
      createdAt: created.toUTC().toISO()!,
    };
  });
}

function agendaFor(tasks: Task[], now: DateTime): Agenda {
  const today = now.startOf("day");
  const groups = new Map<string, { sort: number; items: Agenda[number]["items"] }>();
  const add = (label: string, sort: number, item: Agenda[number]["items"][number]) => {
    const g = groups.get(label) ?? { sort, items: [] };
    g.items.push(item);
    groups.set(label, g);
  };
  for (const t of tasks) {
    const anchorIso = t.dueAt ?? t.windowEnd;
    if (!anchorIso) {
      add("No date", Number.MAX_SAFE_INTEGER, { id: t.id, title: t.title, time: "" });
      continue;
    }
    const at = DateTime.fromISO(anchorIso, { zone: now.zone });
    const time = t.dueAt ? at.toFormat("h:mm a") : "By end of day";
    if (at < now && t.dueAt) {
      add("Overdue", -1, { id: t.id, title: t.title, time: at.toFormat("ccc h:mm a") });
      continue;
    }
    const days = Math.round(at.startOf("day").diff(today, "days").days);
    const label = days === 0 ? `Today · ${at.toFormat("ccc LLL d")}` : days === 1 ? `Tomorrow · ${at.toFormat("ccc LLL d")}` : at.toFormat("ccc LLL d");
    add(label, days * 10_000 + at.hour * 60 + at.minute, { id: t.id, title: t.title, time });
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].sort - b[1].sort)
    .map(([label, g]) => ({ label, items: g.items }));
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function latencyOf(calls: DemoCall[]) {
  const lat = calls.map((c) => c.latencyMs).sort((a, b) => a - b);
  const failed = calls.filter((c) => c.outcome !== "ok").length;
  return { calls: calls.length, p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95), failureRate: calls.length ? failed / calls.length : null };
}

export interface DemoSnapshot {
  health: Health;
  usage: UsageReport;
  agenda: Agenda;
  tasks: Task[];
  approvals: Approval[];
  insights: Insights;
  activity: ActivityItem[];
  reminders: UpcomingReminder[];
  spending: Spending;
}

export function buildDemoSnapshot(nowDate: Date, opts: { days?: number; completed?: ReadonlySet<string>; hiddenExpenses?: ReadonlySet<string> } = {}): DemoSnapshot {
  const now = DateTime.fromJSDate(nowDate, { zone: DEMO_TIMEZONE });
  const days = Math.min(Math.max(opts.days ?? 30, 1), 45);
  const { calls, texts } = generateHistory(now);
  const monthStart = now.startOf("month");
  const todayStart = now.startOf("day");
  const monthCalls = calls.filter((c) => c.ts >= monthStart);
  const monthTexts = texts.filter((t) => t.ts >= monthStart);
  const sum = (xs: DemoCall[]) => xs.reduce((s, c) => s + c.costUsd, 0);

  const tasks = buildTasks(now).filter((t) => !opts.completed?.has(t.id));
  const expenses = generateExpenses(now).filter((e) => !opts.hiddenExpenses?.has(e.id));

  // Daily spend
  const dailySpend: Insights["dailySpend"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = todayStart.minus({ days: i });
    const dayCalls = calls.filter((c) => c.ts.hasSame(day, "day"));
    dailySpend.push({ date: day.toISODate()!, realUsd: sum(dayCalls), simulatedUsd: 0, calls: dayCalls.length });
  }
  const monthReal = sum(monthCalls);
  const elapsed = Math.max(now.diff(monthStart, "days").days, 1 / 24);

  const group = (key: (c: DemoCall) => string) =>
    [...Map.groupBy(monthCalls, key).entries()]
      .map(([k, cs]) => ({
        key: k,
        calls: cs.length,
        inputTokens: cs.reduce((s, c) => s + c.inputTokens, 0),
        outputTokens: cs.reduce((s, c) => s + c.outputTokens, 0),
        cachedTokens: 0,
        realCostUsd: sum(cs),
        simulatedCostUsd: 0,
      }))
      .sort((a, b) => b.calls - a.calls);

  const baselineUsd = monthCalls.reduce((s, c) => s + (c.inputTokens * BASELINE.inPerM + c.outputTokens * BASELINE.outPerM) / 1e6, 0);
  const succeededTexts = monthTexts.filter((t) => t.understood).length;
  const monthlyBudget = 5;

  const usage: UsageReport = {
    generatedAt: now.toUTC().toISO()!,
    timezone: DEMO_TIMEZONE,
    containsSimulatedData: false,
    spend: {
      today: { providerReportedUsd: sum(calls.filter((c) => c.ts >= todayStart)), estimatedUsd: 0, simulatedUsd: 0 },
      last7Days: { providerReportedUsd: sum(calls.filter((c) => c.ts >= todayStart.minus({ days: 6 }))), estimatedUsd: 0, simulatedUsd: 0 },
      thisMonth: { providerReportedUsd: monthReal, estimatedUsd: 0, simulatedUsd: 0 },
    },
    byModel: group((c) => c.model),
    byFeature: group((c) => c.feature),
    calls: {
      total: monthCalls.length,
      ok: monthCalls.filter((c) => c.outcome === "ok").length,
      invalidOutput: monthCalls.filter((c) => c.outcome === "invalid_output").length,
      errors: monthCalls.filter((c) => c.outcome === "error").length,
      blockedByBudget: 0,
      timeouts: 0,
      retries: monthCalls.filter((c) => c.attempt > 1).length,
      fallbacks: monthCalls.filter((c) => c.isFallback).length,
      avgLatencyMs: monthCalls.length ? monthCalls.reduce((s, c) => s + c.latencyMs, 0) / monthCalls.length : null,
    },
    workflows: {
      total: monthTexts.length,
      succeeded: succeededTexts,
      failed: monthTexts.length - succeededTexts,
      unfinished: 0,
      failureRate: monthTexts.length ? (monthTexts.length - succeededTexts) / monthTexts.length : null,
      deterministic: monthTexts.filter((t) => !t.usedModel).length,
      usedModel: monthTexts.filter((t) => t.usedModel).length,
      costPerSuccessfulWorkflowUsd: succeededTexts ? monthReal / succeededTexts : null,
    },
    baseline: {
      model: BASELINE.model,
      priceDate: BASELINE.priceDate,
      hypotheticalClaudeOnlyUsd: baselineUsd,
      actualUsd: monthReal,
      differenceUsd: baselineUsd - monthReal,
      differencePct: baselineUsd > 0 ? ((baselineUsd - monthReal) / baselineUsd) * 100 : null,
      basis: "real calls this month",
      caveats: [
        "Hypothetical: the same token counts priced at Claude API list prices. A different model would use a different number of tokens.",
        "Token-equivalent only. It does NOT show the cheaper models gave equal-quality results.",
      ],
    },
    budget: {
      monthlyUsd: monthlyBudget,
      usedUsd: monthReal,
      usedFraction: monthReal / monthlyBudget,
      thresholds: [0.5, 0.8, 1].map((at) => ({ at, crossed: monthReal / monthlyBudget >= at })),
    },
  };

  const todayTexts = texts.filter((t) => t.ts >= todayStart);
  const insights: Insights = {
    generatedAt: now.toUTC().toISO()!,
    timezone: DEMO_TIMEZONE,
    today: {
      tasksAdded: todayTexts.filter((t) => t.label === "Added a task").length,
      tasksCompleted: todayTexts.filter((t) => t.label === "Marked a task done").length + (opts.completed?.size ?? 0),
      remindersSent: 2,
      textsHandled: todayTexts.length,
    },
    dailySpend,
    projectedMonthUsd: monthReal > 0 ? (monthReal / elapsed) * now.daysInMonth! : null,
    latency: {
      overall: latencyOf(monthCalls),
      byModel: [...Map.groupBy(monthCalls, (c) => c.model).entries()]
        .map(([model, cs]) => ({ model, ...latencyOf(cs) }))
        .sort((a, b) => b.calls - a.calls),
    },
    texts: {
      handled: monthTexts.length,
      deterministic: monthTexts.filter((t) => !t.usedModel).length,
      usedModel: monthTexts.filter((t) => t.usedModel && t.understood).length,
      notUnderstood: monthTexts.filter((t) => !t.understood).length,
    },
  };

  // Activity: texts plus the task events they caused, the last few days.
  const activity: ActivityItem[] = [];
  const recentTexts = texts.filter((t) => t.ts >= todayStart.minus({ days: 3 }));
  const titles = TASKS.map((t) => t.title);
  recentTexts.forEach((t, i) => {
    const iso = t.ts.toUTC().toISO()!;
    activity.push({
      id: `demo_w${i}`,
      ts: iso,
      kind: t.understood ? "text_handled" : "text_not_understood",
      title: t.understood ? t.label : "Couldn't read a text",
      detail: t.usedModel ? "Needed a model" : t.understood ? "No model needed" : null,
    });
    const title = titles[i % titles.length]!;
    if (t.label === "Added a task") activity.push({ id: `demo_e${i}a`, ts: iso, kind: "task_added", title, detail: null });
    if (t.label === "Marked a task done") activity.push({ id: `demo_e${i}d`, ts: iso, kind: "task_completed", title, detail: null });
    if (t.label === "Snoozed a task") activity.push({ id: `demo_e${i}s`, ts: iso, kind: "task_snoozed", title, detail: null });
  });
  for (let d = 0; d <= 3; d++) {
    const at = todayStart.minus({ days: d }).set({ hour: 8, minute: 0 });
    if (at <= now) activity.push({ id: `demo_r${d}`, ts: at.toUTC().toISO()!, kind: "reminder_sent", title: d === 0 ? "Call the dentist to reschedule" : titles[(d * 3) % titles.length]!, detail: null });
    const nudge = todayStart.minus({ days: d }).set({ hour: 15, minute: 10 });
    if (nudge <= now) activity.push({ id: `demo_n${d}`, ts: nudge.toUTC().toISO()!, kind: "nudge_sent", title: "You have a free hour. Want to knock out \"Pay the water bill\"?", detail: null });
  }
  for (const id of opts.completed ?? []) {
    const t = TASKS[Number(id.slice(-2)) - 1];
    if (t) activity.push({ id: `demo_done_${id}`, ts: now.toUTC().toISO()!, kind: "task_completed", title: t.title, detail: "From the dashboard" });
  }
  for (const e of expenses.filter((x) => DateTime.fromISO(x.spentAt) >= todayStart.minus({ days: 3 })).slice(0, 12)) {
    activity.push({ id: `demo_x_${e.id}`, ts: e.spentAt, kind: "expense_logged", title: `$${e.amountUsd.toFixed(2)}${e.merchant ? ` at ${e.merchant}` : e.note ? ` on ${e.note}` : ""}`, detail: e.category });
  }
  activity.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const reminders: UpcomingReminder[] = tasks
    .filter((t) => t.dueAt && DateTime.fromISO(t.dueAt) > now)
    .map((t) => ({ id: `rem_${t.id}`, taskId: t.id, title: t.title, fireAt: t.dueAt! }))
    .sort((a, b) => (a.fireAt < b.fireAt ? -1 : 1));

  const approvals: Approval[] = [
    {
      id: "apr_demo_1",
      code: "K7QPD",
      tool: "shopping.add_to_cart",
      tier: "B",
      action: "add 3 items to the grocery cart (eggs, milk, coffee)",
      target: "grocery",
      priceUsd: 14.27,
      state: "pending",
      requestedAt: now.minus({ minutes: 12 }).toUTC().toISO()!,
      expiresAt: now.plus({ minutes: 48 }).toUTC().toISO()!,
    },
  ];

  const health: Health = {
    ok: true,
    time: now.toISO()!,
    timezone: DEMO_TIMEZONE,
    paused: false,
    dryRun: false,
    jobs: { pending: reminders.length + 1, running: 0, succeeded: 212, dead: 0, cancelled: 4 },
    notificationsQueued: 0,
    pendingApprovals: approvals.length,
    openTasks: tasks.length,
    lastTickAt: now.minus({ seconds: 20 }).toUTC().toISO()!,
    modelProvider: { name: "openrouter", live: true },
    channel: { name: "imessage", live: true },
    calendar: { name: "not-connected", connected: false },
    problems: [],
  };

  return { health, usage, agenda: agendaFor(tasks, now), tasks, approvals, insights, activity: activity.slice(0, 50), reminders, spending: spendingFor(expenses, now) };
}

/**
 * Demo source. Changes are kept in memory for this server process only, so a visitor can try the
 * buttons, and a restart puts everything back.
 */
export function createDemoSource(clock: () => Date = () => new Date()): HomePilotSource {
  const completed = new Set<string>();
  const hiddenExpenses = new Set<string>();
  const snap = (days?: number) => buildDemoSnapshot(clock(), { days, completed, hiddenExpenses });
  return {
    mode: "demo",
    health: async () => snap().health,
    usage: async () => snap().usage,
    agenda: async () => snap().agenda,
    tasks: async () => snap().tasks,
    approvals: async () => snap().approvals,
    insights: async (days) => snap(days).insights,
    activity: async (limit = 50) => snap().activity.slice(0, limit),
    reminders: async () => snap().reminders,
    spending: async () => snap().spending,
    say: async (text) => ({
      authorized: true,
      reply: `This is the demo, so nothing was saved. On the real service, HomePilot's parser would read "${text.slice(0, 80)}" first, and only call a model if the parser could not understand it.`,
      understoodBy: "deterministic",
    }),
    completeTask: async (id) => {
      completed.add(id);
    },
    deleteExpense: async (id) => {
      hiddenExpenses.add(id);
    },
  };
}
