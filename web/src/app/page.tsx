import Link from "next/link";
import { Suspense } from "react";
import { ApprovalButtons } from "@/components/approval-buttons";
import { CommandBox } from "@/components/command-box";
import { ActivityRow, DemoBanner, Problems, ServiceError, StatusStrip } from "@/components/status";
import { TaskList, type TaskRow } from "@/components/task-list";
import { Card, Meter, SkeletonPage, Stat } from "@/components/ui";
import { greeting, longDate, relative, timeOf, usd } from "@/lib/format";
import { HomePilotError } from "@/lib/homepilot/source";
import { getHomePilot } from "@/lib/server/homepilot";
import { realSpend } from "@/lib/spend";

export default function TodayPage() {
  return (
    <Suspense fallback={<SkeletonPage />}>
      <Today />
    </Suspense>
  );
}

async function Today() {
  const hp = await getHomePilot();
  let data;
  try {
    const [health, agenda, insights, reminders, approvals, activity, spending, usage] = await Promise.all([
      hp.health(),
      hp.agenda(),
      hp.insights(7),
      hp.reminders(),
      hp.approvals(),
      hp.activity(6),
      hp.spending(),
      hp.usage(),
    ]);
    data = { health, agenda, insights, reminders, approvals, activity, spending, usage };
  } catch (err) {
    if (!(err instanceof HomePilotError)) throw err;
    return <ServiceError error={err} />;
  }
  const { health, agenda, insights, reminders, approvals, activity, spending, usage } = data;
  const tz = health.timezone;
  const now = new Date(health.time);

  const overdue: TaskRow[] = (agenda.find((g) => g.label === "Overdue")?.items ?? []).map((i) => ({ id: i.id, title: i.title, time: i.time, overdue: true }));
  const today: TaskRow[] = (agenda.find((g) => g.label.startsWith("Today"))?.items ?? []).map((i) => ({ id: i.id, title: i.title, time: i.time }));
  const later = agenda.filter((g) => g.label !== "Overdue" && !g.label.startsWith("Today") && g.label !== "No date");
  const laterCount = later.reduce((n, g) => n + g.items.length, 0);
  const next = reminders[0];
  const pending = approvals.filter((a) => a.state === "pending");
  const budget = spending.budgetUsd;
  const modelSpend = realSpend(usage.spend.thisMonth);

  return (
    <>
      {hp.mode === "demo" && <DemoBanner />}
      <Problems health={health} />
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{greeting(health.time, tz)}</h1>
        <p className="mt-1 text-sm text-ink-2">{longDate(health.time, tz)}</p>
        <div className="mt-3">
          <StatusStrip health={health} now={now} />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Due today" value={today.length + overdue.length} hint={overdue.length ? `${overdue.length} overdue` : "Nothing overdue"} tone={overdue.length ? "critical" : "good"} />
        <Stat label="Next reminder" value={next ? timeOf(next.fireAt, tz) : "None"} hint={next ? `${relative(next.fireAt, now)} · ${next.title}` : "No reminders scheduled"} />
        <Stat label="Done today" value={insights.today.tasksCompleted} hint={`${insights.today.tasksAdded} added`} />
        <Stat label="Texts today" value={insights.today.textsHandled} hint={`${insights.today.remindersSent} reminder${insights.today.remindersSent === 1 ? "" : "s"} sent`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {overdue.length > 0 && (
            <Card title="Overdue">
              <TaskList tasks={overdue} empty="All caught up." />
            </Card>
          )}
          <Card title="Today" action={laterCount > 0 && <Link href="/upcoming" className="hover:text-ink">{laterCount} later this week →</Link>}>
            <TaskList tasks={today} empty="Nothing else due today." />
          </Card>
          <Card title="Message HomePilot">
            <CommandBox demo={hp.mode === "demo"} />
          </Card>
        </div>

        <div className="space-y-4">
          {pending.length > 0 && (
            <Card title="Waiting for you">
              <ul className="space-y-3">
                {pending.map((a) => (
                  <li key={a.id} className="space-y-2">
                    <p className="text-sm">
                      <span className="first-letter:uppercase">{a.action}</span>
                      {a.priceUsd != null && <span className="text-ink-2"> · {usd(a.priceUsd)}</span>}
                    </p>
                    <p className="text-xs text-ink-3">Expires {relative(a.expiresAt, now)} · code {a.code}</p>
                    <ApprovalButtons code={a.code} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Money this month" action={<Link href="/spend" className="hover:text-ink">Details →</Link>}>
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-semibold tracking-tight">{usd(spending.summary.totalUsd)}</span>
              {budget > 0 && <span className="text-xs text-ink-2">of {usd(budget)}</span>}
            </div>
            {budget > 0 && (
              <div className="mt-2">
                <Meter fraction={spending.summary.totalUsd / budget} label="Spending against budget" />
              </div>
            )}
            {spending.summary.byCategory.length > 0 && (
              <p className="mt-2 text-xs text-ink-2">
                Most on {spending.summary.byCategory[0]!.category} ({usd(spending.summary.byCategory[0]!.totalUsd)})
              </p>
            )}
            <p className="mt-3 border-t border-line pt-3 text-xs text-ink-2">
              HomePilot itself: <span className="font-medium text-ink">{usd(modelSpend)}</span> in model calls
            </p>
          </Card>

          <Card title="Recent activity" action={<Link href="/activity" className="hover:text-ink">All →</Link>}>
            <ul className="-my-1 divide-y divide-line">
              {activity.map((a) => (
                <ActivityRow key={a.id} item={a} timeZone={tz} />
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
