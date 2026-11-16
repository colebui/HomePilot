import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { inZone, isQuietHours, nextNonQuiet, parseWhen } from '../src/time.js';

const TZ = 'America/Chicago';
const local = (iso: string): Date => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
const fmt = (d: Date): string => inZone(d, TZ).toFormat("yyyy-LL-dd HH:mm ZZ");

describe('quiet hours', () => {
  const q = (hhmm: string, start = '22:00', end = '08:00'): boolean =>
    isQuietHours(DateTime.fromISO(`2026-11-16T${hhmm}`, { zone: TZ }), start, end);

  it('handles a window that wraps midnight', () => {
    expect(q('21:59')).toBe(false);
    expect(q('22:00')).toBe(true);
    expect(q('03:00')).toBe(true);
    expect(q('07:59')).toBe(true);
    expect(q('08:00')).toBe(false);
  });

  it('handles a same-day window and a disabled window', () => {
    expect(q('13:30', '13:00', '14:00')).toBe(true);
    expect(q('14:00', '13:00', '14:00')).toBe(false);
    expect(q('03:00', '00:00', '00:00')).toBe(false);
  });

  it('finds the next allowed moment', () => {
    const late = DateTime.fromISO('2026-11-16T23:30', { zone: TZ });
    expect(nextNonQuiet(late, '22:00', '08:00').toISO()).toBe(DateTime.fromISO('2026-11-17T08:00', { zone: TZ }).toISO());
    const noon = DateTime.fromISO('2026-11-16T12:00', { zone: TZ });
    expect(nextNonQuiet(noon, '22:00', '08:00').toISO()).toBe(noon.toISO());
  });
});

describe('parseWhen', () => {
  const now = local('2026-11-16T09:00'); // Monday
  const p = (text: string, n = now) => parseWhen(text, n, TZ);

  it('parses relative offsets', () => {
    expect(fmt(p('in 2 hours')!.at)).toBe('2026-11-16 11:00 -06:00');
    expect(fmt(p('in 45 minutes')!.at)).toBe('2026-11-16 09:45 -06:00');
    expect(fmt(p('in 3 days')!.at)).toBe('2026-11-19 09:00 -06:00');
    expect(fmt(p('in an hour')!.at)).toBe('2026-11-16 10:00 -06:00');
  });

  it('parses day words with and without a time', () => {
    const t = p('buy groceries tomorrow')!;
    expect(fmt(t.at)).toBe('2026-11-17 09:00 -06:00');
    expect(t.hasExplicitTime).toBe(false);
    expect(t.kind).toBe('at');
    const u = p('call mom tomorrow at 3pm')!;
    expect(fmt(u.at)).toBe('2026-11-17 15:00 -06:00');
    expect(u.hasExplicitTime).toBe(true);
    expect(fmt(p('friday 14:30')!.at)).toBe('2026-11-20 14:30 -06:00');
    expect(fmt(p('3pm on thursday')!.at)).toBe('2026-11-19 15:00 -06:00');
    expect(fmt(p('2026-12-01 at 8am')!.at)).toBe('2026-12-01 08:00 -06:00');
    expect(fmt(p('tonight')!.at)).toBe('2026-11-16 20:00 -06:00');
  });

  it('rolls a bare weekday or time forward when it has passed', () => {
    // Monday 9am: "monday 8am" already passed, so it means next Monday.
    expect(fmt(p('monday 8am')!.at)).toBe('2026-11-23 08:00 -06:00');
    expect(fmt(p('monday 5pm')!.at)).toBe('2026-11-16 17:00 -06:00');
    expect(fmt(p('at 8am')!.at)).toBe('2026-11-17 08:00 -06:00');
    expect(fmt(p('next friday')!.at)).toBe('2026-11-27 09:00 -06:00');
  });

  it('treats "before" and "by" as deadlines', () => {
    const before = p('return the package before Friday')!;
    expect(before.kind).toBe('deadline');
    expect(fmt(before.at)).toBe('2026-11-19 23:59 -06:00'); // end of Thursday
    const by = p('by friday')!;
    expect(fmt(by.at)).toBe('2026-11-20 23:59 -06:00');
    expect(fmt(p('by friday 5pm')!.at)).toBe('2026-11-20 17:00 -06:00');
  });

  it('parses windows', () => {
    const w = p('a haircut sometime this week')!;
    expect(w.kind).toBe('window');
    expect(fmt(w.windowStart!)).toBe('2026-11-16 09:00 -06:00');
    expect(fmt(w.at)).toBe('2026-11-22 23:59 -06:00');
    const m = p('next month')!;
    expect(fmt(m.windowStart!)).toBe('2026-12-01 00:00 -06:00');
    expect(fmt(m.at)).toBe('2026-12-31 23:59 -06:00');
  });

  it('returns undefined instead of guessing', () => {
    expect(p('renew my passport')).toBeUndefined();
    expect(p('buy 3 apples')).toBeUndefined();
    expect(p('at 25:00')).toBeUndefined();
  });

  it('keeps wall-clock time across the fall DST change (Nov 1 2026)', () => {
    // Saturday Oct 31 2026 is CDT (UTC-5); Sunday Nov 1 is CST (UTC-6) after 2am.
    const sat = local('2026-10-31T20:00');
    const r = p('tomorrow at 9am', sat)!;
    expect(fmt(r.at)).toBe('2026-11-01 09:00 -06:00');
    expect(r.at.toISOString()).toBe('2026-11-01T15:00:00.000Z');
    // 13 real hours later would be 8am: "in 1 days" keeps the wall clock instead.
    expect(fmt(p('in 1 days', sat)!.at)).toBe('2026-11-01 20:00 -06:00');
    // Exact durations stay exact: 24 hours later is 7pm local.
    expect(fmt(p('in 24 hours', sat)!.at)).toBe('2026-11-01 19:00 -06:00');
  });

  it('moves a nonexistent time forward on the spring DST change (Mar 14 2027)', () => {
    const sat = local('2027-03-13T20:00'); // CST
    const r = p('tomorrow at 2:30am', sat)!;
    // 02:30 does not exist on Mar 14 2027; it becomes 03:30 CDT.
    expect(fmt(r.at)).toBe('2027-03-14 03:30 -05:00');
    expect(fmt(p('tomorrow at 9am', sat)!.at)).toBe('2027-03-14 09:00 -05:00');
  });

  it('respects the configured zone', () => {
    const r = parseWhen('tomorrow at 9am', now, 'Asia/Tokyo')!;
    // Monday 15:00Z is already Tuesday 00:00 in Tokyo, so "tomorrow" is Wednesday there.
    expect(inZone(r.at, 'Asia/Tokyo').toFormat('yyyy-LL-dd HH:mm')).toBe('2026-11-18 09:00');
  });
});
