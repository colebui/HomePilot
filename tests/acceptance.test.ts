import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

/**
 * Phase 1 acceptance test from the spec:
 * "A task is persisted, survives a simulated restart, fires once at its due time in a controlled
 *  test, records its outcome, and logs any LLM usage or deterministic no-LLM execution.
 *  No paid API key required to run tests."
 */
describe('Phase 1 acceptance', () => {
  it('create -> save -> schedule -> restart -> trigger once -> mock notification -> snooze -> done', async () => {
    h = harness({ file: true });

    // Create (Monday 9:00 AM Chicago). Deterministic parse: no model call.
    const reply = await h.say('remind me to call the dentist tomorrow at 10am');
    expect(reply).toContain('Saved "Call the dentist"');
    expect(reply).toContain('Tue Nov 17, 10:00 AM CST');
    expect(h.provider.calls).toHaveLength(0);

    const [task] = h.app.tasks.list();
    expect(task!.title).toBe('Call the dentist');
    expect(task!.originalRequest).toBe('remind me to call the dentist tomorrow at 10am');
    expect(h.app.reminders.listScheduled()).toHaveLength(1);
    expect(h.app.scheduler.stats().pending).toBe(1);

    // Simulated restart: brand new process state, same database file.
    let app = h.restart();
    expect(app.tasks.list().map((t) => t.title)).toEqual(['Call the dentist']);
    expect(app.scheduler.stats().pending).toBe(1);

    // Not yet due: one minute early.
    h.clock.set('2026-11-17T15:59:00.000Z');
    await app.tick();
    expect(h.channel.delivered).toHaveLength(0);

    // Due: fires exactly once, however many ticks or restarts follow.
    h.clock.set('2026-11-17T16:00:00.000Z');
    await app.tick();
    await app.tick();
    app = h.restart();
    await app.tick();
    h.clock.advanceMinutes(120);
    await app.tick();
    expect(h.channel.delivered).toHaveLength(1);
    expect(h.channel.delivered[0]!.body).toContain('Reminder: Call the dentist');

    // Outcome is recorded.
    const [reminder] = app.reminders.listForTask(task!.id);
    expect(reminder!.state).toBe('fired');
    const note = app.notifier.list({ kind: 'reminder' })[0]!;
    expect(note.state).toBe('sent');
    expect(note.dryRun).toBe(true);
    const run = app.db.get<{ outcome: string; llm_calls: number }>("SELECT outcome, llm_calls FROM job_runs WHERE job_type = 'reminder.fire'")!;
    expect(run).toMatchObject({ outcome: 'succeeded', llm_calls: 0 });
    expect(app.events.list({ kind: 'reminder.fired' })[0]!.data).toMatchObject({ llmUsed: false, late: false });

    // Deterministic no-LLM execution is logged as such.
    const wf = app.db.all<{ workflow: string; deterministic: number; llm_calls: number; succeeded: number }>(
      'SELECT workflow, deterministic, llm_calls, succeeded FROM workflow_runs ORDER BY started_at',
    );
    expect(wf).toEqual([
      { workflow: 'message', deterministic: 1, llm_calls: 0, succeeded: 1 },
      { workflow: 'reminder.fire', deterministic: 1, llm_calls: 0, succeeded: 1 },
    ]);
    expect(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM llm_calls')!.n).toBe(0);

    // Snooze: reminded once more at the new time, not before.
    expect(await h.say('snooze that until tomorrow 8am')).toContain('Snoozed "Call the dentist" until Wed Nov 18, 8:00 AM CST');
    expect(app.tasks.get(task!.id)!.state).toBe('snoozed');
    h.clock.set('2026-11-18T13:59:00.000Z');
    await app.tick();
    expect(h.channel.delivered).toHaveLength(1);
    h.clock.set('2026-11-18T14:00:00.000Z');
    await app.tick();
    await app.tick();
    expect(h.channel.delivered).toHaveLength(2);
    expect(app.tasks.get(task!.id)!.state).toBe('open');

    // Acknowledge.
    expect(await h.say('done with the dentist')).toContain('Marked "Call the dentist" done');
    expect(app.tasks.get(task!.id)!.state).toBe('done');
    expect(app.reminders.listScheduled()).toHaveLength(0);
    expect(app.notifier.list({ kind: 'reminder' }).every((n) => n.ackAction !== null)).toBe(true);
    h.clock.advanceMinutes(60 * 24 * 7);
    await app.tick();
    expect(h.channel.delivered).toHaveLength(2);
  });

  it('a reminder that came due while HomePilot was off fires once on restart and says it is late', async () => {
    h = harness({ file: true });
    await h.say('remind me to water the plants in 30 minutes');
    h.app.close();

    h.clock.advanceMinutes(60 * 26); // "the Mac was off for a day"
    const app = h.restart();
    await app.tick();
    await app.tick();
    expect(h.channel.delivered).toHaveLength(1);
    expect(h.channel.delivered[0]!.body).toContain('HomePilot was not running then');
    expect(app.events.list({ kind: 'reminder.fired' })[0]!.data).toMatchObject({ late: true });
  });

  it('a crash in the middle of firing does not produce a duplicate message', async () => {
    h = harness({ file: true });
    await h.say('remind me to stretch in 10 minutes');
    h.clock.advanceMinutes(10);
    await h.app.tick();
    expect(h.channel.delivered).toHaveLength(1);

    // Simulate "crashed after the outbox commit but before the job was marked finished":
    // put the job back to running with an expired lease, then restart and tick.
    h.app.db.run("UPDATE jobs SET state = 'running', lease_until = ? WHERE type = 'reminder.fire'", h.clock.now().toISOString());
    const app = h.restart();
    h.clock.advanceMinutes(5);
    const t = await app.tick();
    expect(t.jobs.recovered).toBe(1);
    expect(t.jobs.skipped).toBe(1); // re-run saw the reminder already fired
    expect(h.channel.delivered).toHaveLength(1);
    expect(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'reminder'")!.n).toBe(1);
  });

  it('a failed delivery is retried and still results in exactly one message', async () => {
    h = harness();
    await h.say('remind me to stretch in 10 minutes');
    h.clock.advanceMinutes(10);
    h.channel.failNext = 2;
    expect((await h.app.tick()).notifications.failed).toBe(1);
    expect((await h.app.tick()).notifications.failed).toBe(1);
    expect((await h.app.tick()).notifications.sent).toBe(1);
    await h.app.tick();
    expect(h.channel.delivered).toHaveLength(1);
  });

  it('pausing holds reminders without losing them; resuming delivers once', async () => {
    h = harness();
    await h.say('remind me to stretch in 10 minutes');
    await h.say('pause');
    h.clock.advanceMinutes(30);
    await h.app.tick();
    h.clock.advanceMinutes(30);
    await h.app.tick();
    expect(h.channel.delivered).toHaveLength(0);
    expect(h.app.scheduler.stats().pending).toBeGreaterThan(0);

    await h.say('resume');
    h.clock.advanceMinutes(5);
    await h.app.tick();
    await h.app.tick();
    expect(h.channel.delivered).toHaveLength(1);
  });

  it('a completed or silenced task never fires its reminder', async () => {
    h = harness();
    await h.say('remind me to stretch in 10 minutes');
    await h.say('remind me to email Sam in 20 minutes');
    await h.say('done with stretch');
    await h.say("don't remind me about the email again");
    h.clock.advanceMinutes(60);
    await h.app.tick();
    expect(h.channel.delivered).toHaveLength(0);
    // "don't remind me" keeps the task on the list.
    expect(h.app.tasks.list().map((t) => [t.title, t.doNotRemind])).toEqual([['Email Sam', true]]);
  });
});
