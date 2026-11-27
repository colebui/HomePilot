import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ACTIVITY_META, ActivityRow, DemoBanner, ServiceError } from "@/components/status";
import { Card, Empty, PageHeader, SkeletonPage } from "@/components/ui";
import { dayOf, localDateKey } from "@/lib/format";
import type { ActivityItem } from "@/lib/homepilot/schemas";
import { HomePilotError } from "@/lib/homepilot/source";
import { getHomePilot } from "@/lib/server/homepilot";

export const metadata: Metadata = { title: "Activity" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "tasks", label: "Tasks" },
  { key: "reminders", label: "Reminders" },
  { key: "texts", label: "Texts" },
  { key: "money", label: "Money" },
  { key: "system", label: "System" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export default function ActivityPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  return (
    <>
      <PageHeader title="Activity" subtitle="What HomePilot did, newest first. Your incoming texts are never stored, only what came of them." />
      <Suspense fallback={<SkeletonPage />}>
        <Activity searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Activity({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const filter: FilterKey = FILTERS.some((f) => f.key === show) ? (show as FilterKey) : "all";
  const hp = await getHomePilot();
  let data;
  try {
    const [health, activity] = await Promise.all([hp.health(), hp.activity(200)]);
    data = { health, activity };
  } catch (err) {
    if (!(err instanceof HomePilotError)) throw err;
    return <ServiceError error={err} />;
  }
  const tz = data.health.timezone;
  const items = data.activity.filter((a) => filter === "all" || ACTIVITY_META[a.kind].group === filter);
  const days = new Map<string, ActivityItem[]>();
  for (const a of items) {
    const k = localDateKey(a.ts, tz);
    days.set(k, [...(days.get(k) ?? []), a]);
  }
  const todayKey = localDateKey(data.health.time, tz);

  return (
    <>
      {hp.mode === "demo" && <DemoBanner />}
      <nav aria-label="Filter activity" className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/activity" : `/activity?show=${f.key}`}
            aria-current={filter === f.key ? "true" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${filter === f.key ? "border-ink bg-ink text-page" : "border-line text-ink-2 hover:text-ink"}`}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <div className="space-y-4">
          {[...days.entries()].map(([key, list]) => (
            <Card key={key} title={key === todayKey ? "Today" : dayOf(list[0]!.ts, tz)} action={<span className="tabular">{list.length}</span>}>
              <ul className="-my-1 divide-y divide-line">
                {list.map((a) => (
                  <ActivityRow key={a.id} item={a} timeZone={tz} />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
