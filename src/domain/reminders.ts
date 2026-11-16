import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { newId } from '../ids.js';

export type ReminderState = 'scheduled' | 'fired' | 'acknowledged' | 'cancelled';

export interface Reminder {
  id: string;
  taskId: string;
  fireAt: Date;
  state: ReminderState;
  firedAt: Date | null;
  notificationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  task_id: string;
  fire_at: string;
  state: ReminderState;
  fired_at: string | null;
  notification_id: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: Row): Reminder {
  return {
    id: r.id,
    taskId: r.task_id,
    fireAt: new Date(r.fire_at),
    state: r.state,
    firedAt: r.fired_at ? new Date(r.fired_at) : null,
    notificationId: r.notification_id,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

export class ReminderRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(taskId: string, fireAt: Date): Reminder {
    const id = newId('rem');
    const now = this.clock.now().toISOString();
    this.db.run(
      'INSERT INTO reminders (id, task_id, fire_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      taskId,
      fireAt.toISOString(),
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Reminder | undefined {
    const r = this.db.get<Row>('SELECT * FROM reminders WHERE id = ?', id);
    return r ? fromRow(r) : undefined;
  }

  listForTask(taskId: string, states?: ReminderState[]): Reminder[] {
    const rows = this.db.all<Row>('SELECT * FROM reminders WHERE task_id = ? ORDER BY fire_at ASC', taskId);
    return rows.map(fromRow).filter((r) => !states || states.includes(r.state));
  }

  listScheduled(): Reminder[] {
    return this.db
      .all<Row>("SELECT * FROM reminders WHERE state = 'scheduled' ORDER BY fire_at ASC")
      .map(fromRow);
  }

  /** Mark fired only if still scheduled. Returns false if something else already handled it. */
  markFired(id: string, notificationId: string): boolean {
    const now = this.clock.now().toISOString();
    return (
      this.db.run(
        `UPDATE reminders SET state = 'fired', fired_at = ?, notification_id = ?, updated_at = ?
         WHERE id = ? AND state = 'scheduled'`,
        now,
        notificationId,
        now,
        id,
      ).changes === 1
    );
  }

  acknowledge(id: string): void {
    this.db.run(
      "UPDATE reminders SET state = 'acknowledged', updated_at = ? WHERE id = ? AND state = 'fired'",
      this.clock.now().toISOString(),
      id,
    );
  }

  cancel(id: string): boolean {
    return (
      this.db.run(
        "UPDATE reminders SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'scheduled'",
        this.clock.now().toISOString(),
        id,
      ).changes === 1
    );
  }

  cancelForTask(taskId: string): number {
    return this.db.run(
      "UPDATE reminders SET state = 'cancelled', updated_at = ? WHERE task_id = ? AND state = 'scheduled'",
      this.clock.now().toISOString(),
      taskId,
    ).changes;
  }
}
