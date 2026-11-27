"use client";

import { useState } from "react";
import { compactNumber, usd } from "@/lib/format";

export type ValueFormat = "usd" | "usd-whole";

export function formatValue(kind: ValueFormat, n: number): string {
  if (kind === "usd") return usd(n);
  return n >= 1000 ? `$${compactNumber(n)}` : `$${Math.round(n)}`;
}

export interface BarPoint {
  key: string;
  /** Short axis label, shown for a few bars only. */
  label: string;
  value: number;
  /** Full text for the tooltip and the table view. */
  detail: string;
}

/** A nice round top for the y axis: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (max <= m * pow) return m * pow;
  return 10 * pow;
}

/**
 * Single-series bar chart for values over days. HTML bars rather than SVG so it reflows at any
 * width. Thin bars with rounded data ends anchored to the baseline, a recessive grid, a hover and
 * keyboard tooltip, and a table view for screen readers.
 */
export function BarChart({
  points,
  format,
  label,
  height = 160,
  highlightLast = true,
}: {
  points: BarPoint[];
  /** Named rather than a function: Server Components cannot pass functions to client ones. */
  format: ValueFormat;
  label: string;
  height?: number;
  highlightLast?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(...points.map((p) => p.value), 0));
  const ticks = [top, top / 2, 0];
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const shown = active === null ? null : points[active];

  return (
    <figure className="relative">
      <figcaption className="sr-only">{label}</figcaption>
      <div className="flex gap-2">
        <div className="tabular flex flex-col justify-between text-right text-[11px] text-ink-3" style={{ height }} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0 leading-none">
              {formatValue(format, t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col justify-between" style={{ height }}>
            <div className="border-t border-line" />
            <div className="border-t border-line" />
            <div className="border-t border-line-strong" />
          </div>
          <div className="relative flex items-end gap-[2px]" style={{ height }} onMouseLeave={() => setActive(null)}>
            {points.map((p, i) => {
              const h = top > 0 ? (p.value / top) * 100 : 0;
              const isLast = highlightLast && i === points.length - 1;
              return (
                <button
                  key={p.key}
                  type="button"
                  aria-label={p.detail}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="group relative flex h-full min-w-0 flex-1 items-end focus:outline-none"
                >
                  <span
                    className={`block w-full rounded-t-[4px] transition-opacity ${isLast ? "bg-series-1" : "bg-series-1/70"} ${
                      active !== null && active !== i ? "opacity-40" : ""
                    } group-focus-visible:ring-2 group-focus-visible:ring-accent`}
                    style={{ height: p.value > 0 ? `max(${h}%, 2px)` : 0 }}
                  />
                </button>
              );
            })}
          </div>
          <div aria-hidden className="relative mt-1.5 h-4 text-[11px] text-ink-3">
            {points.map((p, i) => {
              const last = i === points.length - 1;
              // A label every few bars, plus the last one; skip any that would crowd the last.
              if (!last && (i % labelEvery !== 0 || points.length - 1 - i < labelEvery)) return null;
              const center = ((i + 0.5) / points.length) * 100;
              return (
                <span
                  key={p.key}
                  className={`absolute whitespace-nowrap ${i === 0 ? "" : last ? "-translate-x-full" : "-translate-x-1/2"}`}
                  style={{ left: i === 0 ? 0 : last ? "100%" : `${center}%` }}
                >
                  {p.label}
                </span>
              );
            })}
          </div>
          {shown && (
            <div
              role="status"
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md"
              style={{ left: `${((active! + 0.5) / points.length) * 100}%` }}
            >
              <div className="font-medium">{formatValue(format, shown.value)}</div>
              <div className="text-ink-2">{shown.detail}</div>
            </div>
          )}
        </div>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <td>{p.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
