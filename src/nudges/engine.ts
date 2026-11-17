import type { Task } from '../domain/tasks.js';
import { freeMinutesFrom, type Availability } from '../integrations/google-calendar/calendar.js';
import { inZone, isQuietHours } from '../time.js';

export interface NudgePrefs {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  maxPerDay: number;
  /** Minimum minutes between two nudges about the same task. */
  cooldownMinutes: number;
  /** Minimum minutes between any two nudges. */
  globalGapMinutes: number;
  /** A task is never proactively nudged more than this many times unless its deadline is near. */
  maxPerTask: number;
  /** Candidates scoring below this are not worth an interruption. */
  minScore: number;
  /** How far ahead to look for free time. */
  horizonMinutes: number;
  /** Assumed effort when a task has no estimate. Stated in the reason, never hidden. */
  defaultTaskMinutes: number;
  /** Keep this many minutes clear before the next calendar event. */
  bufferMinutes: number;
}

export const DEFAULT_NUDGE_PREFS: Omit<NudgePrefs, 'timezone' | 'quietStart' | 'quietEnd' | 'maxPerDay' | 'cooldownMinutes'> = {
  globalGapMinutes: 60,
  maxPerTask: 3,
  minScore: 25,
  horizonMinutes: 180,
  defaultTaskMinutes: 30,
  bufferMinutes: 10,
};

export interface NudgeInput {
  now: Date;
  tasks: Task[];
  /** IDs of tasks that are done, for dependency checks. */
  completedTaskIds: Set<string>;
  /** Task IDs that already have an explicit reminder scheduled (the reminder will handle them). */
  tasksWithPendingReminder: Set<string>;
  prefs: NudgePrefs;
  nudgesSentToday: number;
  lastNudgeAt: Date | undefined;
  availability: Availability;
  paused: boolean;
}

export interface NudgeCandidate {
  taskId: string;
  title: string;
  score: number;
  /** Human-readable, factual reasons. Shown to the user verbatim. */
  reasons: string[];
  /** null = calendar unavailable, so fit is unknown (never assumed). */
  fitsFreeWindow: boolean | null;
  estimatedMinutes: number;
}

export interface ExcludedTask {
  taskId: string;
  why: string;
}

export type SuppressReason = 'paused' | 'quiet_hours' | 'daily_cap' | 'global_gap' | 'busy_now' | 'no_candidates' | 'below_threshold';

export interface NudgeDecision {
  decision: 'send' | 'none';
  suppressed?: SuppressReason;
  chosen?: NudgeCandidate;
  candidates: NudgeCandidate[];
  excluded: ExcludedTask[];
  /** null when the calendar could not be read. */
  freeMinutes: number | null;
  calendarNote: string;
}

const HOUR = 3_600_000;

function effectiveDeadline(t: Task): Date | null {
  return t.dueAt ?? t.windowEnd ?? null;
}

function describeDue(t: Task, deadline: Date, now: Date): string {
  const hours = (deadline.getTime() - now.getTime()) / HOUR;
  if (hours < 0) return `overdue by ${formatSpan(-hours)}`;
  return t.dueAt ? `due in ${formatSpan(hours)}` : `its time window closes in ${formatSpan(hours)}`;
}

function formatSpan(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Deterministic nudge evaluation: no model call, no randomness, no hidden state.
 * Same input always yields the same decision, which is what makes it testable with a fake clock.
 *
 * It only uses facts it was given. It never infers location, mood, sleep or availability:
 * with no calendar it says availability is unverified instead of assuming free time.
 */
export function evaluateNudges(input: NudgeInput): NudgeDecision {
  const { now, prefs, availability } = input;
  const local = inZone(now, prefs.timezone);

  let freeMinutes: number | null = null;
  let calendarNote: string;
  if (availability.status === 'ok') {
    freeMinutes = freeMinutesFrom(now, availability.busy, prefs.horizonMinutes, prefs.bufferMinutes);
    calendarNote = `calendar checked (${availability.calendarsChecked.join(', ') || 'no calendars'})`;
  } else {
    calendarNote = `calendar not checked: ${availability.reason}`;
  }

  const base = { candidates: [] as NudgeCandidate[], excluded: [] as ExcludedTask[], freeMinutes, calendarNote };
  const none = (suppressed: SuppressReason, extra: Partial<NudgeDecision> = {}): NudgeDecision => ({
    decision: 'none',
    suppressed,
    ...base,
    ...extra,
  });

  // ---- Global gates -------------------------------------------------------
  if (input.paused) return none('paused');
  if (isQuietHours(local, prefs.quietStart, prefs.quietEnd)) return none('quiet_hours');
  if (input.nudgesSentToday >= prefs.maxPerDay) return none('daily_cap');
  if (input.lastNudgeAt && now.getTime() - input.lastNudgeAt.getTime() < prefs.globalGapMinutes * 60_000) {
    return none('global_gap');
  }
  if (freeMinutes !== null && freeMinutes === 0) return none('busy_now');

  // ---- Per-task eligibility and scoring -------------------------------------
  const candidates: NudgeCandidate[] = [];
  const excluded: ExcludedTask[] = [];

  for (const t of input.tasks) {
    const skip = (why: string): void => void excluded.push({ taskId: t.id, why });

    if (t.state === 'done' || t.state === 'dismissed') {
      skip(`task is ${t.state}`);
      continue;
    }
    if (t.doNotRemind) {
      skip('you asked not to be reminded about this');
      continue;
    }
    if (t.state === 'snoozed' && t.snoozeUntil && t.snoozeUntil > now) {
      skip('snoozed');
      continue;
    }
    if (t.windowStart && t.windowStart > now) {
      skip('its time window has not opened yet');
      continue;
    }
    const blockedBy = t.dependsOn.filter((id) => !input.completedTaskIds.has(id));
    if (blockedBy.length > 0) {
      skip(`waiting on ${blockedBy.length} prerequisite task(s)`);
      continue;
    }
    if (input.tasksWithPendingReminder.has(t.id)) {
      skip('an explicit reminder is already scheduled');
      continue;
    }
    if (t.lastNotifiedAt && now.getTime() - t.lastNotifiedAt.getTime() < prefs.cooldownMinutes * 60_000) {
      skip('notified recently (cooldown)');
      continue;
    }

    const deadline = effectiveDeadline(t);
    const hoursLeft = deadline ? (deadline.getTime() - now.getTime()) / HOUR : null;
    const deadlineNear = hoursLeft !== null && hoursLeft <= 24;
    if (t.notificationCount >= prefs.maxPerTask && !deadlineNear) {
      skip(`already nudged ${t.notificationCount} times`);
      continue;
    }

    const estimate = t.estimatedMinutes ?? prefs.defaultTaskMinutes;
    let fits: boolean | null = null;
    if (freeMinutes !== null) {
      fits = estimate <= freeMinutes;
      if (!fits) {
        skip(`needs about ${estimate} min but only ${freeMinutes} min are free`);
        continue;
      }
    }

    const reasons: string[] = [];
    let score = 0;

    if (deadline && hoursLeft !== null) {
      if (hoursLeft <= 72) {
        // 0 pts at 72h out, 40 pts at the deadline, +5 once overdue.
        score += Math.round(40 * (1 - Math.max(0, hoursLeft) / 72)) + (hoursLeft < 0 ? 5 : 0);
      }
      reasons.push(describeDue(t, deadline, now));
    } else {
      const ageDays = (now.getTime() - t.createdAt.getTime()) / (24 * HOUR);
      if (ageDays >= 3) {
        score += 5;
        reasons.push(`on your list for ${Math.floor(ageDays)} days with no date`);
      }
    }

    score += (t.priority - 1) * 8;
    if (t.priority >= 3) reasons.push(t.priority === 4 ? 'marked urgent' : 'marked high priority');

    if (fits === true) {
      score += 15;
      reasons.push(`fits in your next ${freeMinutes} free min`);
      reasons.push(t.estimatedMinutes ? `takes about ${estimate} min` : `no time estimate, so I assumed ${estimate} min`);
    } else {
      score -= 5;
      reasons.push('calendar not checked, so your availability is unverified');
    }

    if (t.location) {
      // No location source exists yet, so location is stated, never assumed.
      reasons.push(`needs to be at: ${t.location} (your location is not known to HomePilot)`);
    }

    score -= t.notificationCount * 8;
    if (t.notificationCount > 0) reasons.push(`nudged ${t.notificationCount} time(s) before`);

    candidates.push({
      taskId: t.id,
      title: t.title,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      fitsFreeWindow: fits,
      estimatedMinutes: estimate,
    });
  }

  // Stable ordering: score, then earliest deadline, then oldest task, then id.
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = effectiveDeadline(byId.get(a.taskId)!)?.getTime() ?? Infinity;
    const db = effectiveDeadline(byId.get(b.taskId)!)?.getTime() ?? Infinity;
    if (da !== db) return da - db;
    const ca = byId.get(a.taskId)!.createdAt.getTime();
    const cb = byId.get(b.taskId)!.createdAt.getTime();
    if (ca !== cb) return ca - cb;
    return a.taskId.localeCompare(b.taskId);
  });

  const result = { candidates, excluded, freeMinutes, calendarNote };
  const top = candidates[0];
  if (!top) return { decision: 'none', suppressed: 'no_candidates', ...result };
  if (top.score < prefs.minScore) return { decision: 'none', suppressed: 'below_threshold', ...result };
  return { decision: 'send', chosen: top, ...result };
}

/** Plain, non-manipulative wording. States the facts and the available replies; nothing else. */
export function renderNudge(c: NudgeCandidate): { body: string; reason: string; actions: string[] } {
  const reason = c.reasons.join('; ');
  return {
    body: `Good time for "${c.title}"? ${capitalize(reason)}. Reply "done", "snooze 2h" or "dismiss".`,
    reason,
    actions: ['done', 'snooze', 'dismiss'],
  };
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
