import { afterEach, describe, expect, it } from 'vitest';
import { cleanTitle, commandFromLlm, matchTasks, parseCommand } from '../src/intent/commands.js';
import { at, harness, MONDAY_9AM, type Harness } from './helpers.js';

const TZ = 'America/Chicago';
const parse = (text: string) => parseCommand(text, at(MONDAY_9AM), TZ);

describe('parseCommand (deterministic, no model)', () => {
  it('understands the example commands from the spec', () => {
    expect(parse('remind me to buy groceries tomorrow')).toMatchObject({ type: 'add_task', title: 'Buy groceries', remind: true, when: { kind: 'at' } });
    expect(parse('add renewing my passport to my tasks')).toMatchObject({ type: 'add_task', title: 'Renewing my passport', remind: false });
    expect(parse('what should I do with my free hour?')).toEqual({ type: 'suggest', minutes: 60 });
    expect(parse('snooze that until Saturday')).toMatchObject({ type: 'snooze', ref: null, when: { kind: 'at' } });
    expect(parse('done with the return')).toEqual({ type: 'done', ref: 'return' });
    expect(parse("don't remind me about that again")).toEqual({ type: 'dismiss', ref: null, forever: true });
    expect(parse('I need a haircut sometime this week.')).toMatchObject({ type: 'add_task', title: 'Haircut', remind: false, when: { kind: 'window' } });
    expect(parse('I need sometime to go to gym tomorrow')).toMatchObject({ type: 'add_task', title: 'Go to gym' });
    expect(parse('Remind me to return that Amazon package before Friday')).toMatchObject({ type: 'add_task', title: 'Return that Amazon package', when: { kind: 'deadline' } });
  });

  it('understands replies to a notification', () => {
    expect(parse('done')).toEqual({ type: 'done', ref: null });
    expect(parse('Done!')).toEqual({ type: 'done', ref: null });
    expect(parse('snooze 2h')).toMatchObject({ type: 'snooze', ref: null, when: { kind: 'at' } });
    expect(parse('snooze 7 hours')).toMatchObject({ type: 'snooze', ref: null, when: { kind: 'at' } });
    expect(parse('snooze for 30 minutes')).toMatchObject({ type: 'snooze', ref: null, when: { kind: 'at' } });
    expect(parse('snooze an hour')).toMatchObject({ type: 'snooze', ref: null, when: { kind: 'at' } });
    expect(parse('snooze 2 days')).toMatchObject({ type: 'snooze', ref: null, when: { kind: 'at' } });
    expect(parse('snooze the dentist 3 hours')).toMatchObject({ type: 'snooze', ref: 'dentist', when: { kind: 'at' } });
    expect(parse('snooze until 9 am')).toMatchObject({ type: 'snooze', ref: null });
    expect(parse('snooze')).toEqual({ type: 'snooze', ref: null });
    expect(parse('dismiss')).toEqual({ type: 'dismiss', ref: null, forever: false });
    expect(parse('snooze the dentist until tomorrow 8am')).toMatchObject({ type: 'snooze', ref: 'dentist' });
  });

  it('understands approvals and controls', () => {
    expect(parse('approve k7q2m')).toEqual({ type: 'approve', code: 'K7Q2M' });
    expect(parse('yes')).toEqual({ type: 'approve' });
    expect(parse('deny K7Q2M')).toEqual({ type: 'deny', code: 'K7Q2M' });
    expect(parse('no')).toEqual({ type: 'deny' });
    expect(parse('pause')).toEqual({ type: 'pause' });
    expect(parse('resume')).toEqual({ type: 'resume' });
    expect(parse('tasks')).toEqual({ type: 'list' });
    expect(parse("what's on my list?")).toEqual({ type: 'list' });
    expect(parse('what reminders do i have')).toEqual({ type: 'list' });
    expect(parse('What reminders do I have?')).toEqual({ type: 'list' });
    expect(parse('reminders')).toEqual({ type: 'list' });
    expect(parse('show my reminders')).toEqual({ type: 'list' });
    expect(parse('what are my reminders')).toEqual({ type: 'list' });
    expect(parse('what tasks do i have today')).toEqual({ type: 'list' });
    expect(parse('what do i have to do')).toEqual({ type: 'list' });
    expect(parse('add butter to my shopping list')).toMatchObject({ type: 'add_task', title: 'Buy butter', remind: false });
    expect(parse('put eggs on the grocery list')).toMatchObject({ type: 'add_task', title: 'Buy eggs' });
    expect(parse('add pick up milk to my shopping list')).toMatchObject({ type: 'add_task', title: 'Pick up milk' });
    expect(parse('usage')).toEqual({ type: 'usage' });
  });

  it('returns undefined for anything else rather than guessing', () => {
    expect(parse('Find a flight to Tokyo sometime next month under $900')).toBeUndefined();
    expect(parse('yesterday was nice')).toBeUndefined();
    expect(parse('   ')).toBeUndefined();
    expect(parse('approve the big purchase please')).toBeUndefined();
  });

  it('cleans titles', () => {
    expect(cleanTitle('to buy milk on ')).toBe('Buy milk');
    expect(cleanTitle('a haircut sometime')).toBe('Haircut');
    expect(cleanTitle('sometime to go to gym')).toBe('Go to gym');
  });
});

describe('matchTasks', () => {
  const tasks = [
    { id: 't1', title: 'Return that Amazon package' },
    { id: 't2', title: 'Return library books' },
    { id: 't3', title: 'Call the dentist' },
  ];
  it('finds a unique match, reports ties, and accepts an id', () => {
    expect(matchTasks('the dentist', tasks).match?.id).toBe('t3');
    expect(matchTasks('amazon return', tasks).match?.id).toBe('t1');
    expect(matchTasks('the return', tasks).ambiguous.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(matchTasks('t2', tasks).match?.id).toBe('t2');
    expect(matchTasks('groceries', tasks)).toEqual({ ambiguous: [] });
  });
});

describe('handleMessage', () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  it('ignores senders that are not on the allowlist: no reply, no task, no model call, text not stored', async () => {
    h = harness();
    const r = await h.app.handleMessage({ sender: '+15550001111', channel: 'imessage', text: 'remind me to SECRET-PAYLOAD tomorrow' });
    expect(r).toEqual({ authorized: false, reply: null, correlationId: null, understoodBy: 'rejected' });
    expect(h.app.tasks.list()).toHaveLength(0);
    expect(h.provider.calls).toHaveLength(0);
    expect(JSON.stringify(h.app.events.list())).not.toContain('SECRET-PAYLOAD');
    expect(h.app.events.list({ kind: 'message.rejected' })).toHaveLength(1);
  });

  it('honors a configured allowlist', async () => {
    h = harness({ env: { HOMEPILOT_ALLOWED_SENDERS: 'local-cli,+15125550100' } });
    expect((await h.app.handleMessage({ sender: '+15125550100', channel: 'imessage', text: 'tasks' })).authorized).toBe(true);
    expect((await h.app.handleMessage({ sender: '+15125550199', channel: 'imessage', text: 'tasks' })).authorized).toBe(false);
  });

  it('asks instead of guessing when a reference is ambiguous or missing', async () => {
    h = harness();
    await h.say('add return the Amazon package to my tasks');
    await h.say('add return library books to my tasks');
    expect(await h.say('done with the return')).toMatch(/matches more than one task: "Return the Amazon package", "Return library books"/);
    expect(h.app.tasks.list()).toHaveLength(2);
    expect(await h.say('done with the unicorn')).toMatch(/couldn't find an open task matching "unicorn"/);
    expect(await h.say('done with the library books')).toMatch(/Marked "Return library books" done/);
  });

  it('"that" means the task most recently created or notified about', async () => {
    h = harness();
    await h.say('remind me to call mom in 10 minutes');
    await h.say('add buy stamps to my tasks');
    h.clock.advanceMinutes(10);
    await h.app.tick(); // the reminder about "call mom" is now the latest context
    expect(await h.say('done')).toContain('Marked "Call mom" done');
    expect(h.app.tasks.list().map((t) => t.title)).toEqual(['Buy stamps']);
  });

  it('asks for a time rather than inventing one', async () => {
    h = harness();
    expect(await h.say('remind me to renew my passport')).toMatch(/Saved "Renew my passport"\. You didn't give a time, so no timed reminder is set/);
    expect(h.app.reminders.listScheduled()).toHaveLength(0);
    expect(await h.say('snooze that')).toMatch(/Until when should I snooze "Renew my passport"\?/);
    expect(h.app.tasks.list()[0]!.state).toBe('open');
  });

  it('says which hour it picked when only a day was given', async () => {
    h = harness();
    expect(await h.say('remind me to buy groceries tomorrow')).toBe(
      'Saved "Buy groceries". I\'ll remind you Tue Nov 17, 9:00 AM CST (no time given, so I picked that hour).',
    );
  });

  it('dismiss removes a task; "don\'t remind me" keeps it but silences it', async () => {
    h = harness();
    await h.say('remind me to floss in 1 hours');
    expect(await h.say('dismiss')).toContain('removed it from your list');
    expect(h.app.tasks.list()).toHaveLength(0);
    expect(h.app.tasks.list({ states: ['dismissed'] })).toHaveLength(1);
  });

  it('reports status and usage in plain words', async () => {
    h = harness();
    await h.say('add buy stamps to my tasks');
    expect(await h.say('status')).toMatch(/^OK\. 1 open task\(s\).*Mode: dry-run\. Model: mock\. Calendar: mock\./);
    expect(await h.say('usage')).toMatch(/This month: \$0\.0000 of \$20\.00 on models; 0 model call\(s\); \d+ of \d+ workflow\(s\) used no model\./);
  });
});

describe('several tasks in one text', () => {
  const tue = (text: string) => parseCommand(text, at('2026-11-17T21:05:00.000Z'), TZ); // Tue 3:05 PM CST

  it('splits a list with its own times into one task each', () => {
    const c = tue('need to eat lunch, go to gym around 430, haircut at 6pm, grab groceries from heb at 7pm');
    expect(c).toMatchObject({ type: 'add_tasks' });
    if (c?.type !== 'add_tasks') throw new Error('expected add_tasks');
    expect(c.items.map((i) => i.title)).toEqual(['Eat lunch', 'Go to gym', 'Haircut', 'Grab groceries from heb']);
    expect(c.items[0]!.when).toBeUndefined();
    expect(c.items.slice(1).map((i) => i.when?.at.toISOString())).toEqual([
      '2026-11-17T22:30:00.000Z',
      '2026-11-18T00:00:00.000Z',
      '2026-11-18T01:00:00.000Z',
    ]);
  });

  it('keeps a shopping-style list as one task, and leaves longer untimed lists to the model', () => {
    expect(tue('remind me to buy eggs and milk tomorrow')).toMatchObject({ type: 'add_task', title: 'Buy eggs and milk' });
    expect(tue('I need to buy eggs, milk tomorrow')).toMatchObject({ type: 'add_task' });
    expect(tue('need to call mom, do laundry, email Sam')).toBeUndefined();
  });

  it('understands "need to" without "I"', () => {
    expect(tue('need to renew my passport')).toMatchObject({ type: 'add_task', title: 'Renew my passport' });
    expect(tue('gotta call the bank tomorrow')).toMatchObject({ type: 'add_task', title: 'Call the bank' });
  });
});

describe('several tasks: model output and the reply', () => {
  let hh: Harness | undefined;
  afterEach(() => hh?.cleanup());

  it('turns a model "tasks" list into one task each, re-parsing every time itself', () => {
    const c = commandFromLlm(
      { intent: 'add_task', tasks: [{ title: 'call mom', when_text: 'tomorrow at 10am' }, { title: 'do laundry' }, { title: 'email Sam' }] },
      at(MONDAY_9AM),
      TZ,
    );
    expect(c).toMatchObject({ type: 'add_tasks', items: [{ title: 'Call mom', when: { kind: 'at' } }, { title: 'Do laundry' }, { title: 'Email Sam' }] });
  });

  it('saves each task with its own reminder and points out a similar open task', async () => {
    hh = harness({ start: '2026-11-17T21:05:00.000Z' });
    await hh.say('add sometime to go to gym to my tasks');
    const reply = await hh.say('need to eat lunch, go to gym around 430, haircut at 6pm, grab groceries from heb at 7pm');
    expect(reply).toMatch(/^Saved 4 tasks:/);
    expect(reply).toMatch(/2\. Go to gym\. I'll remind you Tue Nov 17, 4:30 PM CST\. \(You also have "Go to gym"\.\)/);
    expect(reply).toMatch(/4\. Grab groceries from heb\. I'll remind you Tue Nov 17, 7:00 PM CST\./);
    expect(hh.app.tasks.list({ states: ['open'] })).toHaveLength(5);
    expect(hh.app.scheduler.list({ states: ['pending'] }).filter((j) => j.type === 'reminder.fire')).toHaveLength(3);
  });
});

