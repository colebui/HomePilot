import { inZone } from '../time.js';
import type { Task } from './tasks.js';

export interface AgendaItem {
  id: string;
  title: string;
  /** "4:30 PM", "Any time", "By end of day", or "" for undated tasks. */
  time: string;
  note?: string;
}

export interface AgendaGroup {
  /** "Overdue", "Today · Tue Nov 17", "Tomorrow · Wed Nov 18", "Sun Nov 22", "No date". */
  label: string;
  items: AgendaItem[];
}

/** The moment a task is "for": snooze wins, then a due time, then the end of its window. */
function anchor(t: Task): { at: Date; kind: 'snoozed' | 'due' | 'window' } | undefined {
  if (t.state === 'snoozed' && t.snoozeUntil) return { at: t.snoozeUntil, kind: 'snoozed' };
  if (t.dueAt) return { at: t.dueAt, kind: 'due' };
  if (t.windowEnd) return { at: t.windowEnd, kind: 'window' };
  return undefined;
}

/**
 * Open tasks grouped by local day and sorted by time, for a reply someone reads on a phone.
 * Overdue first, then each day in order, then tasks with no date.
 */
export function buildAgenda(tasks: Task[], now: Date, zone: string): AgendaGroup[] {
  const today = inZone(now, zone).startOf('day');
  const overdue: Array<{ at: number; item: AgendaItem }> = [];
  const byDay = new Map<string, { day: number; label: string; items: Array<{ at: number; item: AgendaItem }> }>();
  const undated: AgendaItem[] = [];

  for (const t of tasks) {
    const a = anchor(t);
    const notes = [a?.kind === 'snoozed' ? 'snoozed' : '', t.doNotRemind ? 'reminders off' : ''].filter(Boolean);
    const note = notes.length ? notes.join(', ') : undefined;
    if (!a) {
      undated.push({ id: t.id, title: t.title, time: '', ...(note ? { note } : {}) });
      continue;
    }
    const local = inZone(a.at, zone);
    const endOfDay = local.hour === 23 && local.minute === 59;
    const time = a.kind === 'window' ? 'By end of day' : endOfDay ? 'Any time' : local.toFormat('h:mm a');
    const item: AgendaItem = { id: t.id, title: t.title, time, ...(note ? { note } : {}) };
    if (a.at < now && a.kind !== 'window') {
      overdue.push({ at: a.at.getTime(), item: { ...item, time: local.hasSame(today, 'day') ? time : local.toFormat('ccc h:mm a') } });
      continue;
    }
    const day = local.startOf('day');
    const key = day.toISODate()!;
    const diff = Math.round(day.diff(today, 'days').days);
    const date = day.toFormat('ccc LLL d');
    const label = diff === 0 ? `Today · ${date}` : diff === 1 ? `Tomorrow · ${date}` : date;
    const g = byDay.get(key) ?? { day: day.toMillis(), label, items: [] };
    g.items.push({ at: a.at.getTime(), item });
    byDay.set(key, g);
  }

  const sortItems = (xs: Array<{ at: number; item: AgendaItem }>): AgendaItem[] => xs.sort((x, y) => x.at - y.at).map((x) => x.item);
  const groups: AgendaGroup[] = [];
  if (overdue.length) groups.push({ label: 'Overdue', items: sortItems(overdue) });
  for (const g of [...byDay.values()].sort((x, y) => x.day - y.day)) groups.push({ label: g.label, items: sortItems(g.items) });
  if (undated.length) groups.push({ label: 'No date', items: undated });
  return groups;
}

/** Plain text for a text message: a heading per day, then "4:30 PM · Go to gym" lines. */
export function renderAgenda(groups: AgendaGroup[]): string {
  return groups
    .map((g) => [g.label, ...g.items.map((i) => `${i.time ? `${i.time} · ` : '• '}${i.title}${i.note ? ` (${i.note})` : ''}`)].join('\n'))
    .join('\n\n');
}
