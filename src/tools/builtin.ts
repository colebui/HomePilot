import { z } from 'zod';
import type { TaskRepo } from '../domain/tasks.js';
import type { ToolDef, ToolRegistry } from './policy.js';

/**
 * Tools registered in Phase 1.
 *
 * Only `tasks.create` does real work. Every external tool below is a MOCK: it has a dry-run
 * description and NO `execute`, so it cannot affect the outside world even with dry-run off.
 * They exist to exercise the policy, approval and audit paths end to end.
 */
export function registerBuiltinTools(registry: ToolRegistry, deps: { tasks: TaskRepo }): void {
  const tasksCreate: ToolDef<{ title: string; priority: number }, { taskId: string }> = {
    name: 'tasks.create',
    tier: 'A',
    scope: 'tasks.write',
    description: 'Create a task in the local HomePilot database.',
    external: false,
    input: z.object({ title: z.string().trim().min(1).max(300), priority: z.number().int().min(1).max(4).default(2) }),
    summarize: (i) => ({ action: `create task "${i.title}"` }),
    dryRun: (i) => ({ taskId: `(dry-run) would create "${i.title}"` }),
    execute: (i) => ({ taskId: deps.tasks.create({ title: i.title, priority: i.priority, source: 'tool' }).id }),
    verify: (o) => typeof o.taskId === 'string' && o.taskId.length > 0,
  };
  registry.register(tasksCreate);

  const calendarCreate: ToolDef<{ title: string; startIso: string; endIso: string; calendarId: string }, { simulated: true; wouldCreate: unknown }> = {
    name: 'calendar.create_event',
    tier: 'B',
    scope: 'calendar.write',
    description: 'MOCK. Create a Google Calendar event. No live integration exists yet.',
    external: true,
    input: z.object({
      title: z.string().min(1).max(200),
      startIso: z.string().datetime({ offset: true }),
      endIso: z.string().datetime({ offset: true }),
      calendarId: z.string().min(1).default('primary'),
    }),
    summarize: (i) => ({ action: `add calendar event "${i.title}"`, target: `${i.calendarId}, ${i.startIso} to ${i.endIso}` }),
    dryRun: (i) => ({ simulated: true, wouldCreate: i }),
  };
  registry.register(calendarCreate);

  const cartAdd: ToolDef<{ retailer: 'heb' | 'amazon'; items: string[] }, { simulated: true; wouldAdd: string[] }> = {
    name: 'shopping.add_to_cart',
    tier: 'B',
    scope: 'shopping.cart',
    description: 'MOCK. Add items to a retailer cart. No live integration exists yet.',
    external: true,
    input: z.object({ retailer: z.enum(['heb', 'amazon']), items: z.array(z.string().min(1).max(120)).min(1).max(50) }),
    summarize: (i) => ({ action: `add ${i.items.length} item(s) to your ${i.retailer} cart`, target: i.items.join(', ') }),
    dryRun: (i) => ({ simulated: true, wouldAdd: i.items }),
  };
  registry.register(cartAdd);

  const placeOrder: ToolDef<{ retailer: 'heb' | 'amazon'; totalUsd: number; orderRef: string }, { simulated: true; wouldOrder: unknown }> = {
    name: 'shopping.place_order',
    tier: 'C',
    scope: 'shopping.purchase',
    description: 'MOCK. Place an order and pay. No live integration exists yet.',
    external: true,
    input: z.object({ retailer: z.enum(['heb', 'amazon']), totalUsd: z.number().positive().max(100_000), orderRef: z.string().min(1).max(120) }),
    summarize: (i) => ({ action: `place ${i.retailer} order ${i.orderRef}`, target: i.retailer, priceUsd: i.totalUsd }),
    dryRun: (i) => ({ simulated: true, wouldOrder: i }),
  };
  registry.register(placeOrder);

  const sendExternal: ToolDef<{ to: string; body: string }, { simulated: true; wouldSendTo: string }> = {
    name: 'message.send_external',
    tier: 'C',
    scope: 'messages.external',
    description: 'MOCK. Send a message to someone other than you. No live integration exists yet.',
    external: true,
    input: z.object({ to: z.string().min(1).max(200), body: z.string().min(1).max(2000) }),
    summarize: (i) => ({ action: 'send a message to another person', target: i.to }),
    dryRun: (i) => ({ simulated: true, wouldSendTo: i.to }),
  };
  registry.register(sendExternal);
}
