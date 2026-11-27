import { afterEach, describe, expect, it } from 'vitest';
import { categorize } from '../src/domain/expenses.js';
import { commandFromLlm, parseCommand, parseExpense } from '../src/intent/commands.js';
import { at, harness, MONDAY_9AM, type Harness } from './helpers.js';

const TZ = 'America/Chicago';
const NOW = at(MONDAY_9AM);
let h: Harness;
afterEach(() => h?.cleanup());

describe('expense parsing', () => {
  it.each([
    ['spent $23 at H-E-B', { amountUsd: 23, merchant: 'H-E-B', note: null, category: 'groceries' }],
    ['Spent 23.50 at Chipotle on lunch', { amountUsd: 23.5, merchant: 'Chipotle', note: 'lunch', category: 'dining' }],
    ['paid $60 for gas', { amountUsd: 60, merchant: null, note: 'gas', category: 'transport' }],
    ['$12.50 lunch at the taco place', { amountUsd: 12.5, merchant: 'the taco place', note: 'lunch', category: 'dining' }],
    ['bought groceries for $45 at Costco', { amountUsd: 45, merchant: 'Costco', note: 'groceries', category: 'groceries' }],
    ['grabbed coffee for 6 bucks', { amountUsd: 6, merchant: null, note: 'coffee', category: 'dining' }],
    ['i spent $1,200 on rent', { amountUsd: 1200, merchant: null, note: 'rent', category: 'bills' }],
    ['spent $30 on a gift', { amountUsd: 30, merchant: null, note: 'gift', category: 'other' }],
    ['paid 45 for gas', { amountUsd: 45, merchant: null, note: 'gas', category: 'transport' }],
    ['spent 18 at Target', { amountUsd: 18, merchant: 'Target', category: 'shopping' }],
  ])('%s', (text, expected) => {
    expect(parseExpense(text, NOW, TZ)).toMatchObject({ type: 'expense', ...expected });
  });

  it('dates "yesterday" and "last night" to the previous local day', () => {
    const y = parseExpense('spent $20 at Target yesterday', NOW, TZ)!;
    expect(y.merchant).toBe('Target');
    expect(y.spentAt?.toISOString()).toBe('2026-11-15T18:00:00.000Z'); // noon CST
    expect(parseExpense('paid $80 for dinner last night', NOW, TZ)!.spentAt?.toISOString()).toBe('2026-11-16T02:00:00.000Z');
  });

  it('never treats a task about money as money already spent', () => {
    for (const text of ['I need to pay $60 for gas', 'remind me to pay the $90 water bill friday', 'pay rent tomorrow', 'spent the day cleaning', 'spent 2 hours on homework', 'got tickets for 2']) {
      const cmd = parseCommand(text, NOW, TZ);
      expect(cmd?.type, text).not.toBe('expense');
    }
    expect(parseExpense('spent $0 at nowhere', NOW, TZ)).toBeUndefined();
  });

  it('keeps an expense and a task in one text apart', () => {
    const cmd = parseCommand('spent $14 on lunch and remind me to call mom at 5pm', NOW, TZ);
    expect(cmd).toMatchObject({ type: 'multi', commands: [{ type: 'expense', amountUsd: 14 }, { type: 'add_task', title: 'Call mom' }] });
  });

  it('separates spending questions from model usage', () => {
    expect(parseCommand('spending', NOW, TZ)).toEqual({ type: 'spending' });
    expect(parseCommand('how much did I spend this month?', NOW, TZ)).toEqual({ type: 'spending' });
    expect(parseCommand('usage', NOW, TZ)).toEqual({ type: 'usage' });
    expect(parseCommand('undo expense', NOW, TZ)).toEqual({ type: 'expense_undo' });
    expect(parseCommand('delete the last expense', NOW, TZ)).toEqual({ type: 'expense_undo' });
  });

  it('accepts an expense classified by the model only with an amount', () => {
    expect(commandFromLlm({ intent: 'expense', amount_usd: 14.333, title: 'lunch' }, NOW, TZ)).toMatchObject({ type: 'expense', amountUsd: 14.33, note: 'lunch', category: 'dining' });
    expect(commandFromLlm({ intent: 'expense', title: 'lunch' }, NOW, TZ)).toBeUndefined();
  });

  it('categorizes by merchant first, then by the words used', () => {
    expect(categorize('HEB')).toBe('groceries');
    expect(categorize(null, 'uber home')).toBe('transport');
    expect(categorize('Amazon')).toBe('shopping');
    expect(categorize(null, 'mystery')).toBe('other');
  });
});

describe('expenses end to end', () => {
  it('logs, summarizes and undoes expenses by text', async () => {
    h = harness({ env: { HOMEPILOT_SPENDING_BUDGET_USD: '500' } });
    expect(await h.say('spent $23 at H-E-B')).toBe('Logged $23.00 at H-E-B as groceries. Groceries this month: $23.00. 5% of your $500.00 budget used. Text "undo expense" if that\'s wrong.');
    await h.say('spent $40.25 at Costco');
    await h.say('paid $12 for lunch');

    const s = h.app.expenses.summary(TZ);
    expect(s).toMatchObject({ totalUsd: 75.25, count: 3, byCategory: [{ category: 'groceries', totalUsd: 63.25, count: 2 }, { category: 'dining', totalUsd: 12, count: 1 }] });
    expect(s.daily.at(-1)).toEqual({ date: '2026-11-16', totalUsd: 75.25, billsUsd: 0 });
    expect(s.daily).toHaveLength(16);

    expect(await h.say('spending')).toContain('This month: $75.25 across 3 expenses');
    expect(await h.say('undo expense')).toBe('Took off the $12.00 expense.');
    expect(h.app.expenses.summary(TZ).totalUsd).toBe(63.25);
    // The row is kept, only hidden: the audit trail stays complete.
    expect(h.app.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM expenses')!.c).toBe(3);
    expect(h.app.events.list({ kind: 'expense.removed' })).toHaveLength(1);
  });

  it('compares with the same days of last month', async () => {
    h = harness();
    h.clock.set('2026-10-10T17:00:00.000Z');
    await h.say('spent $100 at Target');
    h.clock.set('2026-10-25T17:00:00.000Z'); // after day 16 of October: not "same days"
    await h.say('spent $999 at Target');
    h.clock.set(MONDAY_9AM);
    await h.say('spent $10 at Target');
    expect(h.app.expenses.summary(TZ)).toMatchObject({ totalUsd: 10, lastMonthSameDaysUsd: 100 });
  });

  it('rejects impossible amounts at the storage layer', () => {
    h = harness();
    expect(() => h.app.expenses.add({ amountUsd: -5 })).toThrow();
    expect(() => h.app.expenses.add({ amountUsd: 2_000_000 })).toThrow();
  });
});
