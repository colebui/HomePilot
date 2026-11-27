import type { Metadata } from "next";
import { Suspense } from "react";
import { ApprovalButtons } from "@/components/approval-buttons";
import { DemoBanner, ServiceError } from "@/components/status";
import { TaskList } from "@/components/task-list";
import { Badge, Card, Empty, PageHeader, SkeletonPage } from "@/components/ui";
import { dayOf, relative, timeOf, usd } from "@/lib/format";
import { HomePilotError } from "@/lib/homepilot/source";
import { getHomePilot } from "@/lib/server/homepilot";

export const metadata: Metadata = { title: "Upcoming" };

export default function UpcomingPage() {
  return (
    <>
      <PageHeader title="Upcoming" subtitle="Everything on your list by day, and the reminders HomePilot will text you." />
      <Suspense fallback={<SkeletonPage />}>
        <Upcoming />
      </Suspense>
    </>
  );
}

async function Upcoming() {
  const hp = await getHomePilot();
  let data;
  try {
    const [health, agenda, reminders, approvals] = await Promise.all([hp.health(), hp.agenda(), hp.reminders(), hp.approvals()]);
    data = { health, agenda, reminders, approvals };
  } catch (err) {
    if (!(err instanceof HomePilotError)) throw err;
    return <ServiceError error={err} />;
  }
  const { health, agenda, reminders, approvals } = data;
  const tz = health.timezone;
  const now = new Date(health.time);
  const recent = approvals.slice(0, 8);

  return (
    <>
      {hp.mode === "demo" && <DemoBanner />}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {agenda.length === 0 && <Empty>Your list is empty. Text HomePilot something like &ldquo;remind me to call the dentist tomorrow at 10&rdquo;.</Empty>}
          {agenda.map((g) => (
            <Card key={g.label} title={g.label} action={<span className="tabular">{g.items.length}</span>}>
              <TaskList tasks={g.items.map((i) => ({ id: i.id, title: i.note ? `${i.title} (${i.note})` : i.title, time: i.time, overdue: g.label === "Overdue" }))} empty="All done here." />
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          <Card title="Reminders scheduled" action={<span className="tabular">{reminders.length}</span>}>
            {reminders.length === 0 ? (
              <Empty>No reminders scheduled.</Empty>
            ) : (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {reminders.map((r) => (
                  <li key={r.id}>
                    <span aria-hidden className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-surface bg-series-1" />
                    <p className="text-sm">{r.title}</p>
                    <p className="tabular text-xs text-ink-2">
                      {dayOf(r.fireAt, tz)}, {timeOf(r.fireAt, tz)} · {relative(r.fireAt, now)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Approvals">
            <p className="mb-3 text-xs text-ink-2">Anything that spends money or acts for you outside HomePilot waits here for a yes.</p>
            {recent.length === 0 ? (
              <Empty>Nothing has asked for approval.</Empty>
            ) : (
              <ul className="space-y-3">
                {recent.map((a) => (
                  <li key={a.id} className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm first-letter:uppercase">
                        {a.action}
                        {a.priceUsd != null && <span className="text-ink-2"> · {usd(a.priceUsd)}</span>}
                      </p>
                      <Badge tone={a.state === "pending" ? "warning" : a.state === "approved" || a.state === "consumed" ? "good" : "neutral"}>{a.state}</Badge>
                    </div>
                    {a.state === "pending" && (
                      <>
                        <p className="text-xs text-ink-3">Expires {relative(a.expiresAt, now)}</p>
                        <ApprovalButtons code={a.code} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
