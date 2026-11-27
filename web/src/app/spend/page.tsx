import type { Metadata } from "next";
import { Suspense } from "react";
import { BarChart } from "@/components/bar-chart";
import { DeleteExpenseButton } from "@/components/delete-expense";
import { DemoBanner, ServiceError } from "@/components/status";
import { Badge, Card, Empty, Meter, PageHeader, SkeletonPage, Stat } from "@/components/ui";
import { compactNumber, dayOf, modelName, ms, percent, timeOf, usd } from "@/lib/format";
import { HomePilotError } from "@/lib/homepilot/source";
import { getHomePilot } from "@/lib/server/homepilot";
import { PACE_LABEL, PACE_TONE, summarizeModelCost, summarizePersonal } from "@/lib/spend";

export const metadata: Metadata = { title: "Spending" };

export default function SpendPage() {
  return (
    <>
      <PageHeader title="Spending" subtitle="What you've spent this month, and what HomePilot costs to run." />
      <Suspense fallback={<SkeletonPage />}>
        <Spend />
      </Suspense>
    </>
  );
}

const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

async function Spend() {
  const hp = await getHomePilot();
  let data;
  try {
    const [health, spending, usage, insights] = await Promise.all([hp.health(), hp.spending(), hp.usage(), hp.insights(30)]);
    data = { health, spending, usage, insights };
  } catch (err) {
    if (!(err instanceof HomePilotError)) throw err;
    return <ServiceError error={err} />;
  }
  const { health, spending, usage, insights } = data;
  const tz = health.timezone;
  const now = new Date(health.time);
  const me = summarizePersonal(spending, now, tz);
  const ai = summarizeModelCost(usage, insights);
  const maxCat = Math.max(...spending.summary.byCategory.map((c) => c.totalUsd), 0);
  const billsUsd = spending.summary.daily.reduce((s, d) => s + d.billsUsd, 0);
  const recent = spending.recent.slice(0, 10);

  return (
    <>
      {hp.mode === "demo" && <DemoBanner />}

      {/* Personal spending */}
      <section aria-labelledby="yours" className="mb-10">
        <h2 id="yours" className="mb-3 text-lg font-semibold tracking-tight">
          Your spending
        </h2>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="This month" value={usd(me.totalUsd)} hint={`${spending.summary.count} expense${spending.summary.count === 1 ? "" : "s"} texted in`} />
          <Stat
            label="Budget"
            value={me.budgetUsd > 0 ? percent(me.usedFraction) : "Not set"}
            hint={me.status ? `${PACE_LABEL[me.status]} · ${usd(me.budgetUsd)} a month` : "Set HOMEPILOT_SPENDING_BUDGET_USD"}
            tone={me.status ? PACE_TONE[me.status] : undefined}
          />
          <Stat label="At this pace" value={me.projectedUsd === null ? "–" : usd(Math.round(me.projectedUsd))} hint="By the end of the month" />
          <Stat
            label="Vs. last month"
            value={me.vsLastMonthUsd === null ? "–" : `${me.vsLastMonthUsd >= 0 ? "+" : "−"}${usd(Math.abs(me.vsLastMonthUsd))}`}
            hint={me.vsLastMonthFraction === null ? "Nothing to compare yet" : `${percent(Math.abs(me.vsLastMonthFraction))} ${me.vsLastMonthFraction >= 0 ? "more" : "less"} than the same days`}
            tone={me.vsLastMonthFraction === null ? undefined : me.vsLastMonthFraction > 0.1 ? "warning" : "good"}
          />
        </div>
        {me.budgetUsd > 0 && (
          <div className="mb-4 rounded-2xl border border-line bg-surface p-4">
            <div className="mb-2 flex justify-between text-xs text-ink-2">
              <span>
                {usd(me.totalUsd)} of {usd(me.budgetUsd)}
              </span>
              {me.projectedUsd !== null && <span>Marker: projected {usd(Math.round(me.projectedUsd))}</span>}
            </div>
            <Meter fraction={me.usedFraction ?? 0} marker={me.projectedFraction} label="Spending against monthly budget" />
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            title="Day to day this month"
            className="lg:col-span-2"
            action={billsUsd > 0 && <span className="text-xs">Bills left out ({usd(billsUsd)})</span>}
          >
            {spending.summary.count === 0 ? (
              <Empty>No expenses yet. Text HomePilot &ldquo;spent $23 at H-E-B&rdquo; to log one.</Empty>
            ) : (
              <BarChart
                label="Personal spending per day this month, bills left out"
                format="usd-whole"
                points={spending.summary.daily.map((d) => {
                  const v = Math.max(d.totalUsd - d.billsUsd, 0);
                  return {
                    key: d.date,
                    label: shortDay(d.date),
                    value: v,
                    detail: `${weekday(d.date)}: ${usd(v)}${d.billsUsd > 0 ? ` (+${usd(d.billsUsd)} bills)` : ""}`,
                  };
                })}
              />
            )}
          </Card>
          <Card title="By category">
            {spending.summary.byCategory.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <ul className="space-y-2.5">
                {spending.summary.byCategory.map((c) => (
                  <li key={c.category}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="capitalize">{c.category}</span>
                      <span className="tabular">{usd(c.totalUsd)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-series-1" style={{ width: `${maxCat > 0 ? (c.totalUsd / maxCat) * 100 : 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {spending.summary.topMerchants.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="mb-1.5 text-xs font-medium text-ink-2">Top places</p>
                <ul className="space-y-1 text-sm">
                  {spending.summary.topMerchants.map((m) => (
                    <li key={m.merchant} className="flex justify-between">
                      <span className="truncate">{m.merchant}</span>
                      <span className="tabular text-ink-2">
                        {usd(m.totalUsd)} · {m.count}×
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>

        <Card title="Recent expenses" className="mt-4" action={<span className="text-xs">Text &ldquo;undo expense&rdquo; to take back the last one</span>}>
          {recent.length === 0 ? (
            <Empty>Nothing logged yet.</Empty>
          ) : (
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="w-full sm:min-w-[520px] text-sm">
                <thead className="text-left text-xs text-ink-2">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium sm:px-0">When</th>
                    <th className="py-2 font-medium">Where / what</th>
                    <th className="hidden py-2 font-medium sm:table-cell">Category</th>
                    <th className="py-2 text-right font-medium">Amount</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="tabular">
                  {recent.map((e) => (
                    <tr key={e.id} className="border-b border-line last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-ink-2 sm:px-0">
                        {dayOf(e.spentAt, tz)}, {timeOf(e.spentAt, tz)}
                      </td>
                      <td className="py-2">
                        {e.merchant ?? <span className="text-ink-2">{e.note ?? "–"}</span>}
                        {e.merchant && e.note && <span className="text-ink-3"> · {e.note}</span>}
                      </td>
                      <td className="hidden py-2 capitalize text-ink-2 sm:table-cell">{e.category}</td>
                      <td className="py-2 text-right font-medium">{usd(e.amountUsd)}</td>
                      <td className="py-2 pl-2 text-right">
                        <DeleteExpenseButton id={e.id} label={`${usd(e.amountUsd)} ${e.merchant ?? e.note ?? ""}`.trim()} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      {/* What the assistant costs */}
      <section aria-labelledby="assistant">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="assistant" className="text-lg font-semibold tracking-tight">
            What HomePilot costs to run
          </h2>
          <p className="text-xs text-ink-2">Model calls through OpenRouter. Most texts never need one.</p>
        </div>
        {usage.containsSimulatedData && (
          <p className="mb-3 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">Includes simulated calls from the offline mock model. Simulated cost was never billed.</p>
        )}
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Model spend this month" value={usd(ai.monthUsd)} hint={`${PACE_LABEL[ai.status]} · ${usd(ai.budgetUsd)} cap`} tone={PACE_TONE[ai.status]} />
          <Stat label="Texts with no model call" value={percent(ai.freeShare)} hint={`${insights.texts.deterministic} of ${insights.texts.handled} read by the parser`} />
          <Stat label="Cost per text" value={ai.costPerTextUsd === null ? "–" : usd(ai.costPerTextUsd)} hint="Model spend ÷ texts handled" />
          <Stat
            label="Same calls on Claude only"
            value={usd(ai.hypotheticalUsd)}
            hint={ai.savedFraction === null ? "No calls yet" : `${percent(ai.savedFraction)} less with routing (${usage.baseline.model})`}
          />
        </div>
        <div className="mb-4 rounded-2xl border border-line bg-surface p-4">
          <div className="mb-2 flex justify-between text-xs text-ink-2">
            <span>
              {usd(ai.monthUsd)} of the {usd(ai.budgetUsd)} monthly cap · calls stop at the cap
            </span>
            {ai.projectedUsd !== null && <span>Projected {usd(ai.projectedUsd)}</span>}
          </div>
          <Meter fraction={ai.usedFraction} marker={ai.projectedFraction} label="Model spend against monthly cap" />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Model spend, last 30 days" className="lg:col-span-2">
            <BarChart
              label="Model spend per day, last 30 days"
              format="usd"
              points={insights.dailySpend.map((d) => ({
                key: d.date,
                label: shortDay(d.date),
                value: d.realUsd,
                detail: `${weekday(d.date)}: ${usd(d.realUsd)}, ${d.calls} call${d.calls === 1 ? "" : "s"}`,
              }))}
            />
          </Card>
          <Card title="Reliability this month">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-ink-2">Model calls</dt>
                <dd className="tabular font-medium">{usage.calls.total}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-2">Response time</dt>
                <dd className="tabular font-medium">
                  {ms(insights.latency.overall.p50Ms)} <span className="text-xs font-normal text-ink-3">p50</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-2">Slowest 5%</dt>
                <dd className="tabular font-medium">{ms(insights.latency.overall.p95Ms)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-2">Failed calls</dt>
                <dd className="tabular font-medium">{percent(insights.latency.overall.failureRate, 1)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-2">Fell back to another model</dt>
                <dd className="tabular font-medium">{usage.calls.fallbacks}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-2">Blocked by the cap</dt>
                <dd className="tabular font-medium">{usage.calls.blockedByBudget}</dd>
              </div>
            </dl>
          </Card>
        </div>

        <Card title="By model" className="mt-4" action={hp.mode === "live" && <a href="/export" className="hover:text-ink">Export CSV</a>}>
          {usage.byModel.length === 0 ? (
            <Empty>No model calls this month.</Empty>
          ) : (
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-ink-2">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium sm:px-0">Model</th>
                    <th className="py-2 text-right font-medium">Calls</th>
                    <th className="py-2 text-right font-medium">Tokens in / out</th>
                    <th className="py-2 text-right font-medium">p50 / p95</th>
                    <th className="py-2 text-right font-medium">Failed</th>
                    <th className="py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {usage.byModel.map((m) => {
                    const lat = insights.latency.byModel.find((l) => l.model === m.key);
                    return (
                      <tr key={m.key} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 sm:px-0">
                          <span className="font-mono text-xs">{modelName(m.key)}</span>
                        </td>
                        <td className="py-2 text-right">{m.calls}</td>
                        <td className="py-2 text-right text-ink-2">
                          {compactNumber(m.inputTokens)} / {compactNumber(m.outputTokens)}
                        </td>
                        <td className="py-2 text-right text-ink-2">
                          {ms(lat?.p50Ms ?? null)} / {ms(lat?.p95Ms ?? null)}
                        </td>
                        <td className="py-2 text-right text-ink-2">{percent(lat?.failureRate ?? null, 1)}</td>
                        <td className="py-2 text-right font-medium">{usd(m.realCostUsd + m.simulatedCostUsd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {usage.byFeature.map((f) => (
              <Badge key={f.key} tone="neutral">
                {f.key}: {f.calls} call{f.calls === 1 ? "" : "s"} · {usd(f.realCostUsd)}
              </Badge>
            ))}
          </div>
        </Card>
        <details className="mt-3 text-xs text-ink-2">
          <summary className="cursor-pointer">How the Claude-only comparison is worked out</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {usage.baseline.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      </section>
    </>
  );
}
