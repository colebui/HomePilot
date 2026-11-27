/** Formatting helpers. Pure functions: every time is shown in HomePilot's own time zone. */

/** Dollars with enough precision to be honest about tiny model costs: $0.0042, $0.18, $12.40. */
export function usd(n: number): string {
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}$${Number(abs.toPrecision(2)).toString()}`;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function percent(fraction: number | null, digits = 0): string {
  if (fraction === null || !Number.isFinite(fraction)) return "–";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function ms(n: number | null): string {
  if (n === null) return "–";
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

export function timeOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function dayOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

export function longDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
}

/** Local YYYY-MM-DD, for grouping by day. */
export function localDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** "in 25 min", "in 3 h", "5 min ago", "2 days ago", "just now". */
export function relative(iso: string, now: Date): string {
  const diffMin = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(diffMin);
  if (abs < 1) return "just now";
  const text = abs < 60 ? `${abs} min` : abs < 60 * 36 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return diffMin > 0 ? `in ${text}` : `${text} ago`;
}

/** Greeting by local hour. */
export function greeting(iso: string, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** Short model name for tables: "deepseek/deepseek-v4.1-flash-1017" → "deepseek-v4.1-flash-1017". */
export function modelName(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}
