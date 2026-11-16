/**
 * All time in HomePilot flows through a Clock so that scheduling, quiet hours,
 * approvals and budgets can be tested deterministically with a FakeClock.
 * Nothing in src/ may call Date.now() or new Date() directly for "current time".
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date | string) {
    const d = typeof start === 'string' ? new Date(start) : start;
    if (Number.isNaN(d.getTime())) throw new Error(`FakeClock: invalid start time: ${String(start)}`);
    this.ms = d.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  set(to: Date | string): void {
    const d = typeof to === 'string' ? new Date(to) : to;
    if (Number.isNaN(d.getTime())) throw new Error(`FakeClock: invalid time: ${String(to)}`);
    this.ms = d.getTime();
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}

export const iso = (d: Date): string => d.toISOString();
