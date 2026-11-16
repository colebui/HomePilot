/**
 * Calendar abstraction used by the nudge engine.
 *
 * STATUS: the Google Calendar adapter is NOT IMPLEMENTED in Phase 1. Only the interface, the
 * "not connected" provider and an in-memory mock exist. Nothing here talks to Google.
 * HomePilot never treats "calendar unavailable" as "you are free": availability is then
 * reported as unknown and nudges say so.
 */
export interface BusyInterval {
  start: Date;
  end: Date;
  /** Calendar the event came from. Titles are deliberately not carried into nudge logic. */
  calendarId?: string;
}

export type Availability =
  | { status: 'ok'; busy: BusyInterval[]; calendarsChecked: string[] }
  | { status: 'unavailable'; reason: string };

export interface CalendarProvider {
  readonly name: string;
  /** Busy intervals overlapping [from, to). Must report 'unavailable' rather than guess. */
  getAvailability(from: Date, to: Date): Promise<Availability>;
}

export class NotConnectedCalendar implements CalendarProvider {
  readonly name = 'not-connected';
  async getAvailability(): Promise<Availability> {
    return { status: 'unavailable', reason: 'Google Calendar is not connected' };
  }
}

/** In-memory calendar for tests and the demo. Clearly not real data. */
export class MockCalendar implements CalendarProvider {
  readonly name = 'mock';
  private events: BusyInterval[] = [];
  private failure: string | undefined;

  setEvents(events: BusyInterval[]): void {
    this.events = events;
  }

  /** Simulate lost access (revoked OAuth, missing permission). */
  setUnavailable(reason: string | undefined): void {
    this.failure = reason;
  }

  async getAvailability(from: Date, to: Date): Promise<Availability> {
    if (this.failure) return { status: 'unavailable', reason: this.failure };
    return {
      status: 'ok',
      busy: this.events.filter((e) => e.start < to && e.end > from),
      calendarsChecked: ['mock'],
    };
  }
}

/** Merge overlapping or touching busy intervals into a sorted, non-overlapping list. */
export function mergeBusy(busy: BusyInterval[]): BusyInterval[] {
  const sorted = [...busy].filter((b) => b.end > b.start).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: BusyInterval[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      out.push({ start: b.start, end: b.end });
    }
  }
  return out;
}

/** Pairs of events that overlap in time (a conflict the user should know about). */
export function findConflicts(busy: BusyInterval[]): [BusyInterval, BusyInterval][] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: [BusyInterval, BusyInterval][] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.start >= a.end) break;
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * Minutes of uninterrupted free time starting at `now`, looking at most `horizonMinutes` ahead.
 * Returns 0 when `now` is inside a busy interval (after applying the buffer before events).
 */
export function freeMinutesFrom(now: Date, busy: BusyInterval[], horizonMinutes: number, bufferMinutes = 0): number {
  const merged = mergeBusy(busy);
  const horizon = now.getTime() + horizonMinutes * 60_000;
  for (const b of merged) {
    const start = b.start.getTime() - bufferMinutes * 60_000;
    if (b.end.getTime() <= now.getTime()) continue;
    if (start <= now.getTime()) return 0;
    return Math.max(0, Math.floor((Math.min(start, horizon) - now.getTime()) / 60_000));
  }
  return horizonMinutes;
}
