import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { newId } from '../ids.js';

export const TASK_STATES = ['open', 'snoozed', 'done', 'dismissed'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  id: string;
  title: string;
  originalRequest: string | null;
  category: string | null;
  state: TaskState;
  /** 1 = low, 2 = normal, 3 = high, 4 = urgent */
  priority: number;
  dueAt: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  estimatedMinutes: number | null;
  recurrence: string | null;
  dependsOn: string[];
  location: string | null;
  energy: 'low' | 'medium' | 'high' | null;
  snoozeUntil: Date | null;
  completedAt: Date | null;
  doNotRemind: boolean;
  lastNotifiedAt: Date | null;
  notificationCount: number;
  explanation: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export const NewTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  originalRequest: z.string().max(2000).optional(),
  category: z.string().max(60).optional(),
  priority: z.number().int().min(1).max(4).default(2),
  dueAt: z.date().optional(),
  windowStart: z.date().optional(),
  windowEnd: z.date().optional(),
  estimatedMinutes: z.number().int().positive().max(24 * 60).optional(),
  recurrence: z.string().max(200).optional(),
  dependsOn: z.array(z.string()).default([]),
  location: z.string().max(200).optional(),
  energy: z.enum(['low', 'medium', 'high']).optional(),
  explanation: z.string().max(500).optional(),
  source: z.string().max(60).default('user'),
});
export type NewTask = z.input<typeof NewTaskSchema>;

export const TaskPatchSchema = NewTaskSchema.omit({ source: true, originalRequest: true })
  .partial()
  .extend({
    dueAt: z.date().nullable().optional(),
    windowStart: z.date().nullable().optional(),
    windowEnd: z.date().nullable().optional(),
    estimatedMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
    location: z.string().max(200).nullable().optional(),
  });
export type TaskPatch = z.input<typeof TaskPatchSchema>;

interface Row {
  id: string;
  title: string;
  original_request: string | null;
  category: string | null;
  state: TaskState;
  priority: number;
  due_at: string | null;
  window_start: string | null;
  window_end: string | null;
  estimated_minutes: number | null;
  recurrence: string | null;
  depends_on: string;
  location: string | null;
  energy: 'low' | 'medium' | 'high' | null;
  snooze_until: string | null;
  completed_at: string | null;
  do_not_remind: number;
  last_notified_at: string | null;
  notification_count: number;
  explanation: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const d = (s: string | null): Date | null => (s ? new Date(s) : null);
const s = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

function fromRow(r: Row): Task {
  return {
    id: r.id,
    title: r.title,
    originalRequest: r.original_request,
    category: r.category,
    state: r.state,
    priority: r.priority,
    dueAt: d(r.due_at),
    windowStart: d(r.window_start),
    windowEnd: d(r.window_end),
    estimatedMinutes: r.estimated_minutes,
    recurrence: r.recurrence,
    dependsOn: JSON.parse(r.depends_on) as string[],
    location: r.location,
    energy: r.energy,
    snoozeUntil: d(r.snooze_until),
    completedAt: d(r.completed_at),
    doNotRemind: r.do_not_remind === 1,
    lastNotifiedAt: d(r.last_notified_at),
    notificationCount: r.notification_count,
    explanation: r.explanation,
    source: r.source,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`Cannot change a task from "${from}" to "${to}"`);
    this.name = 'InvalidTransitionError';
  }
}

/** Allowed state changes. "done" and "dismissed" are terminal until explicitly reopened. */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  open: ['snoozed', 'done', 'dismissed'],
  snoozed: ['open', 'snoozed', 'done', 'dismissed'],
  done: ['open'],
  dismissed: ['open'],
};

export class TaskRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: NewTask): Task {
    const t = NewTaskSchema.parse(input);
    if (t.windowStart && t.windowEnd && t.windowEnd < t.windowStart) {
      throw new Error('Task window ends before it starts');
    }
    const id = newId('task');
    const now = this.clock.now().toISOString();
    this.db.run(
      `INSERT INTO tasks (id, title, original_request, category, priority, due_at, window_start, window_end,
         estimated_minutes, recurrence, depends_on, location, energy, explanation, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      t.title,
      t.originalRequest ?? null,
      t.category ?? null,
      t.priority,
      s(t.dueAt),
      s(t.windowStart),
      s(t.windowEnd),
      t.estimatedMinutes ?? null,
      t.recurrence ?? null,
      JSON.stringify(t.dependsOn),
      t.location ?? null,
      t.energy ?? null,
      t.explanation ?? null,
      t.source,
      now,
      now,
    );
    return this.require(id);
  }

  get(id: string): Task | undefined {
    const r = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', id);
    return r ? fromRow(r) : undefined;
  }

  require(id: string): Task {
    const t = this.get(id);
    if (!t) throw new TaskNotFoundError(id);
    return t;
  }

  list(filter: { states?: TaskState[] } = {}): Task[] {
    const states = filter.states ?? ['open', 'snoozed'];
    const marks = states.map(() => '?').join(',');
    return this.db
      .all<Row>(
        `SELECT * FROM tasks WHERE state IN (${marks})
         ORDER BY COALESCE(due_at, window_end, '9999') ASC, priority DESC, created_at ASC`,
        ...states,
      )
      .map(fromRow);
  }

  update(id: string, patch: TaskPatch): Task {
    const p = TaskPatchSchema.parse(patch);
    this.require(id);
    const cols: Record<string, string | number | null> = {};
    if (p.title !== undefined) cols.title = p.title;
    if (p.category !== undefined) cols.category = p.category;
    if (p.priority !== undefined) cols.priority = p.priority;
    if (p.dueAt !== undefined) cols.due_at = s(p.dueAt);
    if (p.windowStart !== undefined) cols.window_start = s(p.windowStart);
    if (p.windowEnd !== undefined) cols.window_end = s(p.windowEnd);
    if (p.estimatedMinutes !== undefined) cols.estimated_minutes = p.estimatedMinutes;
    if (p.recurrence !== undefined) cols.recurrence = p.recurrence;
    if (p.dependsOn !== undefined) cols.depends_on = JSON.stringify(p.dependsOn);
    if (p.location !== undefined) cols.location = p.location;
    if (p.energy !== undefined) cols.energy = p.energy;
    if (p.explanation !== undefined) cols.explanation = p.explanation;
    const names = Object.keys(cols);
    if (names.length === 0) return this.require(id);
    this.db.run(
      `UPDATE tasks SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...names.map((n) => cols[n] ?? null),
      this.clock.now().toISOString(),
      id,
    );
    return this.require(id);
  }

  private transition(id: string, to: TaskState, extra: Record<string, string | number | null>): Task {
    const t = this.require(id);
    if (!TRANSITIONS[t.state].includes(to)) throw new InvalidTransitionError(t.state, to);
    const names = Object.keys(extra);
    this.db.run(
      `UPDATE tasks SET state = ?, ${names.map((n) => `${n} = ?, `).join('')}updated_at = ? WHERE id = ?`,
      to,
      ...names.map((n) => extra[n] ?? null),
      this.clock.now().toISOString(),
      id,
    );
    return this.require(id);
  }

  complete(id: string): Task {
    return this.transition(id, 'done', { completed_at: this.clock.now().toISOString(), snooze_until: null });
  }

  dismiss(id: string, opts: { doNotRemind?: boolean } = {}): Task {
    return this.transition(id, 'dismissed', { snooze_until: null, do_not_remind: opts.doNotRemind ? 1 : 0 });
  }

  snooze(id: string, until: Date): Task {
    if (until <= this.clock.now()) throw new Error('Snooze time must be in the future');
    return this.transition(id, 'snoozed', { snooze_until: until.toISOString() });
  }

  reopen(id: string): Task {
    return this.transition(id, 'open', { snooze_until: null, completed_at: null, do_not_remind: 0 });
  }

  /** Stop proactive reminders for a task without closing it. */
  setDoNotRemind(id: string, value: boolean): Task {
    this.require(id);
    this.db.run(
      'UPDATE tasks SET do_not_remind = ?, updated_at = ? WHERE id = ?',
      value ? 1 : 0,
      this.clock.now().toISOString(),
      id,
    );
    return this.require(id);
  }

  /** Move snoozed tasks whose snooze has elapsed back to open. Returns how many woke. */
  wakeDueSnoozes(): number {
    const now = this.clock.now().toISOString();
    return this.db.run(
      `UPDATE tasks SET state = 'open', snooze_until = NULL, updated_at = ?
       WHERE state = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?`,
      now,
      now,
    ).changes;
  }

  noteNotified(id: string): void {
    const now = this.clock.now().toISOString();
    this.db.run(
      `UPDATE tasks SET last_notified_at = ?, notification_count = notification_count + 1, updated_at = ?
       WHERE id = ?`,
      now,
      now,
      id,
    );
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM tasks WHERE id = ?', id).changes > 0;
  }
}
