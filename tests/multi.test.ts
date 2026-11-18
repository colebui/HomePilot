import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand } from '../src/intent/commands.js';
import { at, harness, type Harness } from './helpers.js';

const TZ = 'America/Chicago';
const NOW = '2026-11-18T00:58:00.000Z'; // Tue Nov 17, 6:58 PM CST
const parse = (text: string) => parseCommand(text, at(NOW), TZ);

let h: Harness | undefined;
afterEach(() => h?.cleanup());

async function cole(): Promise<Harness> {
  const hh = harness({ start: '2026-11-17T21:05:00.000Z' });
  await hh.say('need to eat lunch, go to gym around 430, therapy at 6pm, grab groceries from heb at 7pm');
  hh.clock.advanceMinutes(113); // 6:58 PM
  return hh;
}

describe('several requests in one text: parsing', () => {
  it('reads "X done" with the word at the end', () => {
    expect(parse('gym done')).toEqual({ type: 'done', ref: 'gym' });
    expect(parse('therapy is done')).toEqual({ type: 'done', ref: 'therapy' });
    expect(parse('the laundry is finished')).toEqual({ type: 'done', ref: 'laundry' });
    expect(parse("I'm done")).toEqual({ type: 'done', ref: null });
  });

  it('reads "going to X now" as starting a task', () => {
    expect(parse('going to pickup groceries now')).toEqual({ type: 'started', ref: 'pickup groceries' });
    expect(parse("I'm heading to the gym now")).toEqual({ type: 'started', ref: 'gym' });
  });

  it('splits updates and new requests', () => {
    expect(parse('gym done, therapy done, going to pickup groceries now')).toEqual({
      type: 'multi',
      commands: [
        { type: 'done', ref: 'gym' },
        { type: 'done', ref: 'therapy' },
        { type: 'started', ref: 'pickup groceries' },
      ],
    });
    expect(parse('done with gym and remind me to call mom at 8pm')).toMatchObject({
      type: 'multi',
      commands: [{ type: 'done', ref: 'gym' }, { type: 'add_task', title: 'Call mom', remind: true }],
    });
    expect(parse('done with gym. tasks?')).toMatchObject({ type: 'multi', commands: [{ type: 'done' }, { type: 'list' }] });
    expect(parse('snooze therapy 2h, add laundry to my list. tasks')).toMatchObject({
      type: 'multi',
      commands: [{ type: 'snooze', ref: 'therapy' }, { type: 'add_task', title: 'Laundry' }, { type: 'list' }],
    });
  });

  it('keeps one request whole', () => {
    expect(parse('remind me to buy eggs, milk and bread tomorrow')).toMatchObject({ type: 'add_task', title: 'Buy eggs, milk and bread' });
    expect(parse('remind me to call mom and dad at 8pm')).toMatchObject({ type: 'add_task', title: 'Call mom and dad' });
    expect(parse('approve AB12 and add laundry to my list')).toBeUndefined();
  });

  it('marks what it understood and names what it did not', () => {
    expect(parse('gym done, the weather is nice')).toEqual({ type: 'multi', commands: [{ type: 'done', ref: 'gym' }], unparsed: ['the weather is nice'] });
  });
});

describe('several requests in one text: what happens', () => {
  it("handles Cole's text from Nov 17", async () => {
    h = await cole();
    const reply = await h.say('gym done, therapy done, going to pickup groceries now');
    expect(reply).toBe(
      [
        'Marked "Go to gym" done. Its reminders are cancelled.',
        'Marked "Therapy" done. Its reminders are cancelled.',
        `Got it, you're on "Grab groceries from heb", so no more reminders for it. Text "done" when you finish.`,
      ].join('\n'),
    );
    const open = h.app.tasks.list({ states: ['open', 'snoozed'] }).map((t) => t.title);
    expect(open).toEqual(expect.arrayContaining(['Eat lunch', 'Grab groceries from heb']));
    expect(open).not.toContain('Go to gym');
    expect(open).not.toContain('Therapy');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('completes several tasks named together', async () => {
    h = await cole();
    expect(await h.say('done with gym and therapy')).toBe('Marked "Go to gym" and "Therapy" done. Their reminders are cancelled.');
  });

  it('runs what it understood when the model cannot read the rest', async () => {
    h = await cole();
    const reply = await h.say('gym done, the weather is nice');
    expect(reply).toMatch(/^Marked "Go to gym" done\. Its reminders are cancelled\.\nI didn't understand "the weather is nice", so I left that alone\./);
  });
});
