import type { ReactNode } from "react";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {action && <div className="text-sm text-ink-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "good" | "warning" | "critical" }) {
  const toneClass = tone === "good" ? "text-good" : tone === "warning" ? "text-warning" : tone === "critical" ? "text-critical" : "text-ink-2";
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className={`mt-1 text-xs ${toneClass}`}>{hint}</div>}
    </div>
  );
}

/** A progress meter with a status label, so the state never depends on color alone. */
export function Meter({ fraction, label, marker }: { fraction: number; label: string; marker?: number | null }) {
  const pct = Math.max(0, Math.min(fraction, 1)) * 100;
  const tone = fraction >= 1 ? "bg-critical" : fraction >= 0.8 ? "bg-warning" : "bg-series-1";
  return (
    <div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        className="relative h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        {marker != null && marker > 0 && (
          <div
            aria-hidden
            title="Projected by month end"
            className="absolute top-[-2px] h-3 w-0.5 rounded bg-ink-2"
            style={{ left: `calc(${Math.min(marker, 1) * 100}% - 1px)` }}
          />
        )}
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "good" | "warning" | "critical" | "neutral" | "accent"; children: ReactNode }) {
  const cls = {
    good: "bg-good-soft text-good",
    warning: "bg-warning-soft text-warning",
    critical: "bg-critical-soft text-critical",
    neutral: "bg-surface-2 text-ink-2",
    accent: "bg-accent-soft text-accent",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function Dot({ tone }: { tone: "good" | "warning" | "critical" | "neutral" }) {
  const cls = { good: "bg-good", warning: "bg-warning", critical: "bg-critical", neutral: "bg-ink-3" }[tone];
  return <span aria-hidden className={`inline-block size-2 rounded-full ${cls}`} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-ink-2">{children}</p>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-2xl bg-surface-2 ${className}`} />;
}

export function SkeletonPage() {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}
