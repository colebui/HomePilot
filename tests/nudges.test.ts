import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/tasks.js';
import { findConflicts, freeMinutesFrom, mergeBusy, type Availability } from '../src/integrations/google-calendar/calendar.js';
import { DEFAULT_NUDGE_PREFS, evaluateNudges, renderNudge, type NudgeInput, type NudgePrefs } from '../src/nudges/engine.js';
import { at, harness, MONDAY_9AM, type Harness } from './helpers.js';

const NOW = at(MONDAY_9AM); // Mon 9:00 AM Chicago
const prefs: NudgePrefs = { ...DEFAULT_NUDGE_PREFS, timezone: 'America/Chicago', quietStart: '22:00', quietEnd: '08:00', maxPerDay: 3, cooldownMinutes: 240 };
const hours = (n: number): Date => new Date(NOW.getTime() + n * 3_600_000);

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq++;
  return {
    id: `task_${seq}`, title: `Task ${seq}`, originalRequest: null, category: null, state: 'open', priority: 2,
    dueAt: null, windowStart: null, windowEnd: null, estimatedMinutes: null, recurrence: null, dependsOn: [],
    location: null, energy: null, snoozeUntil: null, completedAt: null, doNotRemind: false, lastNotifiedAt: null,
    notificationCount: 0, explanation: null, source: 'test', createdAt: hours(-1), updatedAt: hours(-1), ...over,
  };
}
const FREE: Availability = { status: 'ok', busy: [], calendarsChecked: ['primary'] };
function input(over: Partial<NudgeInput> = {}): NudgeInput {
  return {
    now: NOW, tasks: [], completedTaskIds: new Set(), tasksWithPendingReminder: new Set(), prefs,
    nudgesSentToday: 0, lastNudgeAt: undefined, availability: FREE, paused: false, ...over,
  };
}

describe('calendar helpers', () => {
  it('merges overlapping busy intervals and finds conflicts', () => {
    const busy = [
      { start: hours(1), end: hours(2) },
      { start: hours(1.5), end: hours(3) },
      { start: hours(5), end: hours(6) },
    ];
    expect(mergeBusy(busy)).toEqual([{ start: hours(1), end: hours(3) }, { start: hours(5), end: hours(6) }]);
    expect(findConflicts(busy)).toHaveLength(1);
    expect(findConflicts([{ start: hours(1), end: hours(2) }, { start: hours(2), end: hours(3) }])).toHaveLength(0);
  });

  it('computes free minutes with a buffer, and zero when busy now', () => {
    expect(freeMinutesFrom(NOW, [], 180)).toBe(180);
    expect(freeMinutesFrom(NOW, [{ start: hours(1), end: hours(2) }], 180)).toBe(60);
    expect(freeMinutesFrom(NOW, [{ start: hours(1), end: hours(2) }], 180, 10)).toBe(50);
    expect(freeMinutesFrom(NOW, [{ start: hours(-1), end: hours(1) }], 180)).toBe(0);
    expect(freeMinutesFrom(NOW, [{ start: hours(-3), end: hours(-2) }], 180)).toBe(180);
  });
});

describe('nudge engine (deterministic)', () => {
  it('is a pure function: same input, same decision', () => {
    const tasks = [task({ dueAt: hours(10), priority: 3 }), task({ dueAt: hours(30) }), task()];
    const a = evaluateNudges(input({ tasks }));
    const b = evaluateNudges(input({ tasks }));
    expect(a).toEqual(b);
    expect(a.decision).toBe('send');
    expect(a.chosen!.taskId).toBe(tasks[0]!.id);
  });

  it('never nudges during quiet hours, while paused, over the daily cap or too soon after the last nudge', () => {
    const tasks = [task({ dueAt: hours(2), priority: 4 })];
    expect(evaluateNudges(input({ tasks, now: at('2026-11-17T05:00:00.000Z') })).suppressed).toBe('quiet_hours'); // 11 PM
    expect(evaluateNudges(input({ tasks, now: at('2026-11-16T13:59:00.000Z') })).suppressed).toBe('quiet_hours'); // 7:59 AM
    expect(evaluateNudges(input({ tasks, paused: true })).suppressed).toBe('paused');
    expect(evaluateNudges(input({ tasks, nudgesSentToday: 3 })).suppressed).toBe('daily_cap');
    expect(evaluateNudges(input({ tasks, lastNudgeAt: hours(-0.5) })).suppressed).toBe('global_gap');
    expect(evaluateNudges(input({ tasks, lastNudgeAt: hours(-2) })).decision).toBe('send');
  });

  it('respects the calendar: busy now means no nudge; a task must fit the free window', () => {
    const big = task({ dueAt: hours(5), estimatedMinutes: 120 });
    const small = task({ dueAt: hours(20), estimatedMinutes: 20 });
    const busyNow: Availability = { status: 'ok', busy: [{ start: hours(-1), end: hours(1) }], calendarsChecked: ['primary'] };
    expect(evaluateNudges(input({ tasks: [big, small], availability: busyNow })).suppressed).toBe('busy_now');

    // Meeting in 45 minutes (35 usable after the 10 minute buffer): only the small task fits.
    const soon: Availability = { status: 'ok', busy: [{ start: hours(0.75), end: hours(2) }], calendarsChecked: ['primary'] };
    const d = evaluateNudges(input({ tasks: [big, small], availability: soon }));
    expect(d.freeMinutes).toBe(35);
    expect(d.chosen!.taskId).toBe(small.id);
    expect(d.excluded.find((e) => e.taskId === big.id)!.why).toMatch(/needs about 120 min but only 35 min are free/);
    expect(d.chosen!.reasons.join(' ')).toMatch(/fits in your next 35 free min/);
  });

  it('never invents availability when the calendar cannot be read', () => {
    const d = evaluateNudges(input({ tasks: [task({ dueAt: hours(6), priority: 3 })], availability: { status: 'unavailable', reason: 'Google Calendar is not connected' } }));
    expect(d.freeMinutes).toBeNull();
    expect(d.calendarNote).toMatch(/not checked/);
    expect(d.chosen!.fitsFreeWindow).toBeNull();
    expect(d.chosen!.reasons.join(' ')).toMatch(/availability is unverified/);
    expect(renderNudge(d.chosen!).body).toMatch(/unverified/);
  });

  it('never assumes location', () => {
    const d = evaluateNudges(input({ tasks: [task({ dueAt: hours(6), location: 'UPS Store' })] }));
    expect(d.chosen!.reasons.join(' ')).toMatch(/your location is not known/);
  });

  it('excludes tasks that are snoozed, silenced, blocked, not yet in window, already reminded or on cooldown', () => {
    const dep = task();
    const tasks = [
      task({ dueAt: hours(3), state: 'snoozed', snoozeUntil: hours(2) }),
      task({ dueAt: hours(3), doNotRemind: true }),
      task({ dueAt: hours(3), dependsOn: [dep.id] }),
      task({ dueAt: hours(3), windowStart: hours(1) }),
      task({ dueAt: hours(3), lastNotifiedAt: hours(-1), notificationCount: 1 }),
      task({ dueAt: hours(3) }),
    ];
    const d = evaluateNudges(input({ tasks, tasksWithPendingReminder: new Set([tasks[5]!.id]) }));
    expect(d.decision).toBe('none');
    expect(d.suppressed).toBe('no_candidates');
    expect(d.excluded.map((e) => e.why)).toEqual([
      'snoozed',
      'you asked not to be reminded about this',
      'waiting on 1 prerequisite task(s)',
      'its time window has not opened yet',
      'notified recently (cooldown)',
      'an explicit reminder is already scheduled',
    ]);
    // Once the prerequisite is done the blocked task becomes eligible.
    const unblocked = evaluateNudges(input({ tasks: [tasks[2]!], completedTaskIds: new Set([dep.id]) }));
    expect(unblocked.decision).toBe('send');
  });

  it('stops nagging: gives up after maxPerTask nudges unless the deadline is close', () => {
    const far = task({ dueAt: hours(60), notificationCount: 3, priority: 4 });
    expect(evaluateNudges(input({ tasks: [far] })).excluded[0]!.why).toMatch(/already nudged 3 times/);
    const near = task({ dueAt: hours(5), notificationCount: 3, priority: 4 });
    expect(evaluateNudges(input({ tasks: [near] })).decision).toBe('send');
  });

  it('does not interrupt for low-value tasks', () => {
    const d = evaluateNudges(input({ tasks: [task({ priority: 1 })] }));
    expect(d.suppressed).toBe('below_threshold');
    expect(d.candidates).toHaveLength(1);
  });

  it('every suggestion carries a plain reason and the available replies, with no pressure language', () => {
    const d = evaluateNudges(input({ tasks: [task({ title: 'Renew passport', dueAt: hours(20), priority: 3 })] }));
    const msg = renderNudge(d.chosen!);
    expect(msg.reason.length).toBeGreaterThan(10);
    expect(msg.actions).toEqual(['done', 'snooze', 'dismiss']);
    expect(msg.body).toMatch(/^Good time for "Renew passport"\? Due in 20 h/);
    expect(msg.body).not.toMatch(/!|hurry|last chance|don't miss|you (must|need to|should)/i);
  });
});

describe('nudges through the scheduler', () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  it('sends one calendar-aware nudge, then respects cooldown, the daily cap and quiet hours', async () => {
    h = harness({ env: { HOMEPILOT_MAX_NUDGES_PER_DAY: '2', HOMEPILOT_NUDGE_COOLDOWN_MINUTES: '120' } });
    h.calendar.setEvents([]);
    h.app.addTask({ title: 'Renew passport', dueAt: at('2026-11-17T03:00:00.000Z'), priority: 3, estimatedMinutes: 30 });
    h.app.ensureNudgeLoop();

    const nudges = (): number => h.channel.delivered.filter((m) => m.body.startsWith('Good time for')).length;

    h.clock.advanceMinutes(30); // 9:30 AM: first evaluation slot
    await h.app.tick();
    await h.app.tick();
    expect(nudges()).toBe(1);
    expect(h.channel.delivered[0]!.body).toMatch(/Good time for "Renew passport"\? Due in 12 h; marked high priority; fits in your next 180 free min/);

    // Every 30 minutes for the next 90: still inside the 2 hour cooldown.
    for (let i = 0; i < 3; i++) {
      h.clock.advanceMinutes(30);
      await h.app.tick();
    }
    expect(nudges()).toBe(1);

    h.clock.advanceMinutes(60); // 12:00: cooldown over
    await h.app.tick();
    expect(nudges()).toBe(2);

    // Rest of the day: the daily cap of 2 holds, and quiet hours start at 22:00.
    for (let i = 0; i < 30; i++) {
      h.clock.advanceMinutes(30);
      await h.app.tick();
    }
    expect(nudges()).toBe(2);
    expect(h.app.events.list({ kind: 'nudge.evaluated', limit: 500 }).some((e) => e.data.suppressed === 'daily_cap')).toBe(true);
    expect(h.app.events.list({ kind: 'nudge.evaluated', limit: 500 }).some((e) => e.data.suppressed === 'quiet_hours')).toBe(true);
    expect(h.app.events.list({ kind: 'nudge.evaluated', limit: 500 }).every((e) => e.data.llmUsed === false)).toBe(true);
    // The loop keeps exactly one future evaluation queued.
    expect(h.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'nudge.evaluate' AND state = 'pending'")!.n).toBe(1);
  });

  it('a nudge that is re-run after a crash is not sent twice', async () => {
    h = harness({ file: true });
    h.app.addTask({ title: 'Renew passport', dueAt: at('2026-11-17T03:00:00.000Z'), priority: 3 });
    h.app.ensureNudgeLoop();
    h.clock.advanceMinutes(30);
    await h.app.tick();
    h.app.db.run("UPDATE jobs SET state = 'running', lease_until = ? WHERE type = 'nudge.evaluate' AND state = 'succeeded'", h.clock.now().toISOString());
    const app = h.restart();
    h.clock.advanceMinutes(1);
    await app.tick();
    expect(h.channel.delivered).toHaveLength(1);
  });

  it('with no calendar connected it says so instead of assuming free time', async () => {
    h = harness();
    h.calendar.setUnavailable('Google Calendar is not connected');
    h.app.addTask({ title: 'Renew passport', dueAt: at('2026-11-17T03:00:00.000Z'), priority: 3 });
    h.app.ensureNudgeLoop();
    h.clock.advanceMinutes(30);
    await h.app.tick();
    expect(h.channel.delivered[0]!.body).toMatch(/calendar not checked, so your availability is unverified/);
  });

  it('"what should I do with my free hour?" uses the time the user stated, and only tasks that fit', async () => {
    h = harness();
    h.calendar.setUnavailable('Google Calendar is not connected');
    h.app.addTask({ title: 'Deep clean garage', estimatedMinutes: 180, priority: 4 });
    h.app.addTask({ title: 'Book dentist', estimatedMinutes: 10, priority: 2 });
    const reply = await h.say('what should I do with my free hour?');
    expect(reply).toMatch(/the time you said you have/);
    expect(reply).toMatch(/Book dentist/);
    expect(reply).not.toMatch(/Deep clean garage/);
    expect(h.channel.delivered).toHaveLength(0); // answering a question sends no notification
  });
});
