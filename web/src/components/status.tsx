import { HomePilotError } from "@/lib/homepilot/source";
import type { ActivityItem, Health } from "@/lib/homepilot/schemas";
import { relative, timeOf } from "@/lib/format";
import { Badge, Dot } from "./ui";

/** What is connected and whether HomePilot is healthy, in one line. */
export function StatusStrip({ health, now }: { health: Health; now: Date }) {
  const items: Array<{ label: string; tone: "good" | "warning" | "critical" | "neutral"; text: string }> = [
    { label: "Texts", tone: health.channel.live ? "good" : "warning", text: health.channel.live ? `${health.channel.name} live` : health.channel.name === "dry-run" ? "dry run" : `${health.channel.name} (dry run)` },
    { label: "Model", tone: health.modelProvider.live ? "good" : "neutral", text: health.modelProvider.live ? health.modelProvider.name : "offline mock" },
    { label: "Calendar", tone: health.calendar.connected ? "good" : "neutral", text: health.calendar.connected ? "connected" : "not connected" },
    { label: "Reminders", tone: health.paused ? "warning" : "good", text: health.paused ? "paused" : "on" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-2">
      {health.ok ? <Badge tone="good">✓ Running</Badge> : <Badge tone="critical">! Needs attention</Badge>}
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <Dot tone={i.tone} />
          <span className="text-ink-3">{i.label}</span> {i.text}
        </span>
      ))}
      {health.lastTickAt && <span className="text-ink-3">Checked {relative(health.lastTickAt, now)}</span>}
    </div>
  );
}

export function Problems({ health }: { health: Health }) {
  if (health.problems.length === 0) return null;
  return (
    <div role="alert" className="mb-4 rounded-2xl border border-critical/30 bg-critical-soft px-4 py-3 text-sm text-critical">
      <p className="font-medium">HomePilot needs attention</p>
      <ul className="mt-1 list-disc pl-5">
        {health.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="mb-5 rounded-2xl border border-accent/25 bg-accent-soft px-4 py-3 text-sm text-ink">
      <span className="font-medium">Demo with made-up data.</span>{" "}
      <span className="text-ink-2">
        The real dashboard reads HomePilot&apos;s local API on a home Mac mini. The numbers here are generated so the page looks lived-in without
        showing anyone&apos;s personal data.
      </span>
    </div>
  );
}

/** Shown in place of a section when the service cannot be reached or answers oddly. */
export function ServiceError({ error }: { error: unknown }) {
  const e = error instanceof HomePilotError ? error : undefined;
  const hint =
    e?.kind === "unreachable"
      ? "Is the HomePilot service running? Check with: launchctl print gui/$(id -u)/com.homepilot.scheduler"
      : e?.kind === "unauthorized"
        ? "HOMEPILOT_API_TOKEN in web/.env.local must match HOMEPILOT_API_TOKEN in the service's .env."
        : e?.kind === "bad_response"
          ? "The service and the dashboard disagree about a response shape. Update both to the same commit."
          : null;
  return (
    <div role="alert" className="rounded-2xl border border-critical/30 bg-critical-soft p-5 text-sm">
      <p className="font-medium text-critical">Couldn&apos;t load this from HomePilot</p>
      <p className="mt-1 text-ink-2">{e?.message ?? "Unexpected error."}</p>
      {hint && <p className="mt-2 font-mono text-xs text-ink-2">{hint}</p>}
    </div>
  );
}

export const ACTIVITY_META: Record<ActivityItem["kind"], { icon: string; tone: "good" | "warning" | "critical" | "neutral" | "accent"; group: "tasks" | "reminders" | "texts" | "money" | "system" }> = {
  task_added: { icon: "+", tone: "accent", group: "tasks" },
  task_completed: { icon: "✓", tone: "good", group: "tasks" },
  task_snoozed: { icon: "z", tone: "neutral", group: "tasks" },
  task_dismissed: { icon: "–", tone: "neutral", group: "tasks" },
  reminder_sent: { icon: "⏰", tone: "accent", group: "reminders" },
  nudge_sent: { icon: "→", tone: "accent", group: "reminders" },
  text_handled: { icon: "✉", tone: "neutral", group: "texts" },
  text_not_understood: { icon: "?", tone: "warning", group: "texts" },
  paused: { icon: "Ⅱ", tone: "warning", group: "system" },
  resumed: { icon: "▶", tone: "good", group: "system" },
  budget_alert: { icon: "!", tone: "warning", group: "money" },
  expense_logged: { icon: "$", tone: "neutral", group: "money" },
  approval: { icon: "✓", tone: "neutral", group: "system" },
  problem: { icon: "!", tone: "critical", group: "system" },
};

export function ActivityRow({ item, timeZone }: { item: ActivityItem; timeZone: string }) {
  const meta = ACTIVITY_META[item.kind];
  const toneCls = {
    good: "bg-good-soft text-good",
    warning: "bg-warning-soft text-warning",
    critical: "bg-critical-soft text-critical",
    neutral: "bg-surface-2 text-ink-2",
    accent: "bg-accent-soft text-accent",
  }[meta.tone];
  return (
    <li className="flex items-start gap-3 py-2">
      <span aria-hidden className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${toneCls}`}>
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{item.title}</p>
        {item.detail && <p className="text-xs text-ink-3 first-letter:uppercase">{item.detail}</p>}
      </div>
      <time dateTime={item.ts} className="tabular shrink-0 text-xs text-ink-3">
        {timeOf(item.ts, timeZone)}
      </time>
    </li>
  );
}
