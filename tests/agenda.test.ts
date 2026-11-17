import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(() => h?.cleanup());

describe('the "tasks" reply', () => {
  it('groups by day, sorts by time and puts the time first', async () => {
    h = harness({ start: '2026-11-17T21:05:00.000Z' }); // Tue Nov 17, 3:05 PM CST
    await h.say('need to eat lunch, go to gym around 430, therapy at 6pm, grab groceries from heb at 7pm');
    await h.say('I need to pick up dry cleaning this week');
    await h.say('remind me to call the bank tomorrow at 9am');
    await h.say('remind me to pay rent at 3pm'); // 3 PM already passed today, so tomorrow 3 PM
    const reply = await h.say('tasks');
    expect(reply).toBe(
      [
        'Today · Tue Nov 17',
        '4:30 PM · Go to gym',
        '6:00 PM · Therapy',
        '7:00 PM · Grab groceries from heb',
        '',
        'Tomorrow · Wed Nov 18',
        '9:00 AM · Call the bank',
        '3:00 PM · Pay rent',
        '',
        'Sun Nov 22',
        'By end of day · Pick up dry cleaning',
        '',
        'No date',
        '• Eat lunch',
      ].join('\n'),
    );
  });

  it('lists overdue and snoozed tasks clearly', async () => {
    h = harness({ start: '2026-11-17T21:05:00.000Z' });
    await h.say('remind me to call mom at 4pm');
    await h.say('remind me to water plants at 5pm');
    h.clock.advanceMinutes(60); // 4:05 PM: the call is overdue
    await h.say('snooze plants until tomorrow 8am');
    expect(await h.say('tasks')).toBe(['Overdue', '4:00 PM · Call mom', '', 'Tomorrow · Wed Nov 18', '8:00 AM · Water plants (snoozed)'].join('\n'));
  });
});
