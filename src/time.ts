import { DateTime } from 'luxon';

/** Convert an instant to a zoned DateTime. */
export function inZone(d: Date, zone: string): DateTime {
  return DateTime.fromJSDate(d, { zone });
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * True if the local wall-clock time falls inside quiet hours.
 * Handles windows that wrap midnight (22:00-08:00). start === end means "no quiet hours".
 */
export function isQuietHours(local: DateTime, start: string, end: string): boolean {
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s === e) return false;
  const now = local.hour * 60 + local.minute;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The next instant at or after `local` that is outside quiet hours. */
export function nextNonQuiet(local: DateTime, start: string, end: string): DateTime {
  if (!isQuietHours(local, start, end)) return local;
  const [eh, em] = end.split(':').map(Number);
  let candidate = local.set({ hour: eh ?? 0, minute: em ?? 0, second: 0, millisecond: 0 });
  if (candidate <= local) candidate = candidate.plus({ days: 1 });
  return candidate;
}

export function startOfLocalDay(d: Date, zone: string): Date {
  return inZone(d, zone).startOf('day').toJSDate();
}

export function startOfLocalMonth(d: Date, zone: string): Date {
  return inZone(d, zone).startOf('month').toJSDate();
}

/** Short, human-friendly local time for messages, e.g. "Fri Nov 20, 9:00 AM CST". */
export function formatLocal(d: Date, zone: string): string {
  return inZone(d, zone).toFormat("ccc LLL d, h:mm a ZZZZ");
}

// ---------------------------------------------------------------------------
// Deterministic natural-language time parsing (no model call).
// ---------------------------------------------------------------------------

export type WhenKind = 'at' | 'deadline' | 'window';

export interface ParsedWhen {
  kind: WhenKind;
  /** For 'at': the moment. For 'deadline': the latest moment. For 'window': the end of the window. */
  at: Date;
  /** Only for 'window': when the window opens. */
  windowStart?: Date;
  /** True when the user gave a clock time (vs. only a day). */
  hasExplicitTime: boolean;
  /** The exact substring that was understood, so callers can strip it from the task title. */
  matched: string;
}

const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7,
};

const DAY_WORD =
  'today|tonight|tomorrow|tmrw|(?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)|\\d{4}-\\d{2}-\\d{2}';
const TIME_WORD = '(?:at\\s+)?(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|\\d{1,2}:\\d{2}|noon|midnight)';
const PART_WORD = '(?:in\\s+the\\s+|this\\s+)?(?:morning|afternoon|evening)';

const RE_RELATIVE = /\bin\s+(\d+|an?|half an)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i;
const RE_WINDOW = /\b(?:sometime\s+|some\s+time\s+)?(this week|next week|this weekend|next weekend|this month|next month)\b/i;
const RE_DEADLINE = new RegExp(`\\b(before|by)\\s+(?:the\\s+end\\s+of\\s+)?(?:on\\s+)?(${DAY_WORD})(?:\\s+(${TIME_WORD}))?`, 'i');
const RE_DAY_TIME = new RegExp(
  `\\b(?:(?:on|until|till)\\s+)?(${DAY_WORD})(?:\\s+(${TIME_WORD}|${PART_WORD}))?(?=$|[\\s,.!?])`,
  'i',
);
const RE_TIME_DAY = new RegExp(`(?:^|\\s)(${TIME_WORD})\\s+(?:on\\s+)?(${DAY_WORD})(?=$|[\\s,.!?])`, 'i');
const RE_TIME_ONLY = new RegExp(`(?:^|\\s)(at\\s+(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|noon|midnight)|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))(?=$|[\\s,.!?])`, 'i');

const DEFAULT_HOUR = 9;

function parseClock(text: string): { hour: number; minute: number } | undefined {
  const t = text.toLowerCase().replace(/^at\s+/, '').replace(/^(in the|this)\s+/, '').trim();
  if (t === 'noon') return { hour: 12, minute: 0 };
  if (t === 'midnight') return { hour: 0, minute: 0 };
  if (t === 'morning') return { hour: 9, minute: 0 };
  if (t === 'afternoon') return { hour: 14, minute: 0 };
  if (t === 'evening') return { hour: 18, minute: 0 };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (minute > 59) return undefined;
  if (mer) {
    if (hour < 1 || hour > 12) return undefined;
    if (mer === 'pm' && hour !== 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return undefined;
  }
  return { hour, minute };
}

/** Resolve a day word to the start of that local day, strictly using calendar arithmetic. */
function resolveDay(word: string, now: DateTime): DateTime | undefined {
  const w = word.toLowerCase().replace(/\s+/g, ' ').trim();
  const today = now.startOf('day');
  if (w === 'today' || w === 'tonight') return today;
  if (w === 'tomorrow' || w === 'tmrw') return today.plus({ days: 1 });
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
    const d = DateTime.fromISO(w, { zone: now.zone });
    return d.isValid ? d.startOf('day') : undefined;
  }
  const isNext = w.startsWith('next ');
  const name = isNext ? w.slice(5) : w;
  const target = WEEKDAYS[name];
  if (!target) return undefined;
  // "next friday" = the Friday of the following calendar week (weeks start Monday).
  if (isNext) return today.startOf('week').plus({ weeks: 1, days: target - 1 });
  // A bare weekday = its next occurrence, today included; the caller rolls forward a week
  // if the resulting time has already passed.
  return today.plus({ days: (target - now.weekday + 7) % 7 });
}

function atLocal(day: DateTime, hour: number, minute: number): DateTime {
  // luxon resolves DST gaps by moving forward and overlaps by taking the earlier offset.
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Parse the first time expression in `text`, relative to `now` in `zone`.
 * Returns undefined when nothing is recognized. Callers must NOT guess in that case.
 */
export function parseWhen(text: string, nowDate: Date, zone: string): ParsedWhen | undefined {
  const now = inZone(nowDate, zone);

  const rel = RE_RELATIVE.exec(text);
  if (rel) {
    const qty = rel[1]!.toLowerCase();
    const unit = rel[2]!.toLowerCase();
    const n = qty === 'a' || qty === 'an' ? 1 : qty === 'half an' ? 0.5 : Number(qty);
    const minutes = unit.startsWith('min')
      ? n
      : unit.startsWith('h')
        ? n * 60
        : unit.startsWith('d')
          ? n * 1440
          : n * 10_080;
    if (minutes > 0 && minutes <= 366 * 1440) {
      // Day/week offsets keep the wall-clock time across DST; shorter offsets are exact durations.
      const at = unit.startsWith('d')
        ? now.plus({ days: n })
        : unit.startsWith('w')
          ? now.plus({ weeks: n })
          : now.plus({ minutes });
      return { kind: 'at', at: at.toJSDate(), hasExplicitTime: true, matched: rel[0] };
    }
  }

  const dl = RE_DEADLINE.exec(text);
  if (dl) {
    const day = resolveDay(dl[2]!, now);
    if (day) {
      const clock = dl[3] ? parseClock(dl[3]) : undefined;
      let at: DateTime;
      if (clock) at = atLocal(day, clock.hour, clock.minute);
      else if (dl[1]!.toLowerCase() === 'before') at = day.minus({ days: 1 }).endOf('day'); // "before Friday" = by the end of Thursday
      else at = day.endOf('day'); // "by Friday" = any time Friday
      if (at <= now && !/^\d{4}/.test(dl[2]!)) at = at.plus({ weeks: 1 });
      return { kind: 'deadline', at: at.toJSDate(), hasExplicitTime: Boolean(clock), matched: dl[0] };
    }
  }

  const win = RE_WINDOW.exec(text);
  if (win) {
    const which = win[1]!.toLowerCase();
    let start = now;
    let end: DateTime;
    switch (which) {
      case 'this week':
        end = now.endOf('week');
        break;
      case 'next week':
        start = now.startOf('week').plus({ weeks: 1 });
        end = start.endOf('week');
        break;
      case 'this weekend': {
        const sat = now.startOf('week').plus({ days: 5 });
        start = sat > now ? sat : now;
        end = now.endOf('week');
        break;
      }
      case 'next weekend':
        start = now.startOf('week').plus({ weeks: 1, days: 5 });
        end = start.plus({ days: 1 }).endOf('day');
        break;
      case 'this month':
        end = now.endOf('month');
        break;
      default:
        start = now.startOf('month').plus({ months: 1 });
        end = start.endOf('month');
    }
    return {
      kind: 'window',
      at: end.toJSDate(),
      windowStart: start.toJSDate(),
      hasExplicitTime: false,
      matched: win[0],
    };
  }

  const td = RE_TIME_DAY.exec(text);
  const dt = td ? undefined : RE_DAY_TIME.exec(text);
  const dayWord = td?.[2] ?? dt?.[1];
  const timeWord = td?.[1] ?? dt?.[2];
  if (dayWord) {
    const day = resolveDay(dayWord, now);
    if (day) {
      const tonight = dayWord.toLowerCase() === 'tonight';
      const clock = timeWord ? parseClock(timeWord) : undefined;
      let at = atLocal(day, clock?.hour ?? (tonight ? 20 : DEFAULT_HOUR), clock?.minute ?? 0);
      const isDate = /^\d{4}/.test(dayWord);
      const isToday = ['today', 'tonight'].includes(dayWord.toLowerCase());
      if (at <= now && !isDate) {
        if (isToday && !clock) {
          // "today" with no time, said after the default hour: one hour from now, on the hour.
          at = now.plus({ hours: 1 }).startOf('hour');
        } else if (!isToday) {
          at = at.plus({ weeks: 1 });
        }
      }
      const matched = (td?.[0] ?? dt?.[0] ?? '').trim();
      return { kind: 'at', at: at.toJSDate(), hasExplicitTime: Boolean(clock), matched };
    }
  }

  const to = RE_TIME_ONLY.exec(text);
  if (to) {
    const clock = parseClock(to[1]!);
    if (clock) {
      let at = atLocal(now.startOf('day'), clock.hour, clock.minute);
      if (at <= now) at = at.plus({ days: 1 });
      return { kind: 'at', at: at.toJSDate(), hasExplicitTime: true, matched: to[0].trim() };
    }
  }

  return undefined;
}
