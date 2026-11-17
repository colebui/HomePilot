import { DateTime } from 'luxon';
import { SystemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { buildAgenda, renderAgenda, type AgendaGroup } from './domain/agenda.js';
import { ApprovalStore, type Approval } from './domain/approvals.js';
import { EventLog } from './domain/events.js';
import { PreferenceStore, SystemState } from './domain/preferences.js';
import { ReminderRepo, type Reminder } from './domain/reminders.js';
import { TaskRepo, type NewTask, type Task } from './domain/tasks.js';
import { newId } from './ids.js';
import { NotConnectedCalendar, type Availability, type CalendarProvider } from './integrations/google-calendar/calendar.js';
import {
  INTENT_SYSTEM_PROMPT,
  LlmIntentSchema,
  commandFromLlm,
  matchTasks,
  parseCommand,
  type Command,
} from './intent/commands.js';
import { MockProvider } from './models/mock.js';
import { OpenRouterProvider } from './models/openrouter.js';
import { PriceBook } from './models/pricing.js';
import { ModelRouter, type ClassPolicy } from './models/router.js';
import type { ModelProvider, TaskClass } from './models/types.js';
import { DryRunChannel, Notifier, type Channel } from './notify/notifier.js';
import { DEFAULT_NUDGE_PREFS, evaluateNudges, renderNudge, type NudgeDecision, type NudgePrefs } from './nudges/engine.js';
import { Scheduler, type Job, type JobResult, type TickSummary } from './scheduler/scheduler.js';
import { resolveSecret } from './secrets.js';
import { buildUsageReport, type UsageReport } from './telemetry/report.js';
import { Telemetry } from './telemetry/usage.js';
import { formatLocal, inZone, isQuietHours, nextNonQuiet, startOfLocalDay, type ParsedWhen } from './time.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { ToolExecutor, type ExecResult } from './tools/executor.js';
import { PolicyEngine, ToolRegistry } from './tools/policy.js';

export interface AppOptions {
  config: Config;
  clock?: Clock;
  channel?: Channel;
  calendar?: CalendarProvider;
  provider?: ModelProvider;
  /** Count simulated (mock) spend toward the budget ceiling. For tests and the demo only. */
  budgetIncludesSimulated?: boolean;
}

export interface InboundMessage {
  /** Identity of the sender as verified by the channel adapter (never taken from message text). */
  sender: string;
  channel: string;
  text: string;
}

export interface MessageResult {
  authorized: boolean;
  /** null = say nothing (for example an unknown sender). */
  reply: string | null;
  correlationId: string | null;
  /** How the message was understood. */
  understoodBy: 'deterministic' | 'model' | 'not_understood' | 'rejected';
  /** The model that read the message, as the provider reported it. Absent when no model was used. */
  model?: string;
  command?: Command['type'];
}

export interface Health {
  ok: boolean;
  time: string;
  timezone: string;
  paused: boolean;
  dryRun: boolean;
  schemaVersion: number;
  jobs: Record<string, number>;
  notificationsQueued: number;
  pendingApprovals: number;
  openTasks: number;
  lastTickAt: string | null;
  modelProvider: { name: string; live: boolean };
  channel: { name: string; live: boolean };
  calendar: { name: string; connected: boolean };
  problems: string[];
}

const HELP =
  'Try: "remind me to return the package before Friday", "I need a haircut sometime this week", ' +
  '"tasks", "done with the return", "snooze that until Saturday", "don\'t remind me about that again", ' +
  '"what should I do with my free hour?", "status", "usage", "pause", "resume".';

/**
 * Composition root. Owns the database handle and wires every component together.
 * Construct with App.open(); everything a caller needs hangs off the instance.
 */
export class App {
  readonly db: Db;
  readonly clock: Clock;
  readonly config: Config;
  readonly events: EventLog;
  readonly tasks: TaskRepo;
  readonly reminders: ReminderRepo;
  readonly prefs: PreferenceStore;
  readonly system: SystemState;
  readonly scheduler: Scheduler;
  readonly notifier: Notifier;
  readonly calendar: CalendarProvider;
  readonly prices: PriceBook;
  readonly telemetry: Telemetry;
  readonly router: ModelRouter;
  readonly registry: ToolRegistry;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalStore;
  readonly executor: ToolExecutor;
  private readonly provider: ModelProvider;
  private readonly budgetIncludesSimulated: boolean;

  static open(opts: AppOptions): App {
    return new App(opts);
  }

  private constructor(opts: AppOptions) {
    const { config } = opts;
    this.config = config;
    this.clock = opts.clock ?? new SystemClock();
    this.db = openDatabase(config.dbPath, this.clock.now().toISOString());
    this.events = new EventLog(this.db, this.clock);
    this.tasks = new TaskRepo(this.db, this.clock);
    this.reminders = new ReminderRepo(this.db, this.clock);
    this.prefs = new PreferenceStore(this.db, this.clock);
    this.system = new SystemState(this.db, this.clock);
    this.scheduler = new Scheduler(this.db, this.clock);
    this.notifier = new Notifier(this.db, this.clock, this.system, opts.channel ?? new DryRunChannel());
    this.calendar = opts.calendar ?? new NotConnectedCalendar();
    this.prices = new PriceBook(this.db);
    this.prices.seedDefaults();
    this.telemetry = new Telemetry(this.db, this.clock, this.prices, {
      baselineModel: config.budget.baselineModel,
      timezone: config.timezone,
    });
    this.budgetIncludesSimulated = opts.budgetIncludesSimulated ?? false;

    this.provider = opts.provider ?? this.buildProvider();
    const cls = (models: string[]): ClassPolicy => ({
      models,
      timeoutMs: config.models.timeoutMs,
      maxOutputTokens: config.models.maxOutputTokens,
      maxRetries: config.models.maxRetries,
    });
    const policy: Record<TaskClass, ClassPolicy> = {
      fast: cls(config.models.fast),
      balanced: cls(config.models.balanced),
      premium: cls(config.models.premium),
    };
    this.router = new ModelRouter({
      provider: this.provider,
      policy,
      telemetry: this.telemetry,
      budget: { monthlyUsd: config.budget.monthlyUsd, includeSimulated: this.budgetIncludesSimulated },
      maxConcurrency: config.models.maxConcurrency,
      onCallRecorded: () => this.checkBudgetAlerts(),
    });

    this.registry = new ToolRegistry();
    registerBuiltinTools(this.registry, { tasks: this.tasks });
    this.policy = new PolicyEngine(this.system, { tierBMode: config.policy.tierBMode });
    this.policy.seedDefaults();
    this.approvals = new ApprovalStore(this.db, this.clock);
    this.executor = new ToolExecutor({
      db: this.db,
      clock: this.clock,
      registry: this.registry,
      policy: this.policy,
      approvals: this.approvals,
      events: this.events,
      notifier: this.notifier,
      dryRun: config.dryRun,
      approvalTtlMinutes: config.policy.approvalTtlMinutes,
      timezone: config.timezone,
    });

    // Travel interests from the spec are seeded as unconfirmed hypotheses the user can edit.
    this.prefs.seed(
      'travel.interests',
      ['nightlife', 'live music', 'urban exploration', 'scenic viewpoints', 'local food', 'distinctive neighborhoods', 'vintage shopping', 'social activities', 'cultural attractions'],
      'hypothesis',
    );

    this.scheduler.register('reminder.fire', (job) => this.handleReminderFire(job));
    this.scheduler.register('nudge.evaluate', (job) => this.handleNudgeEvaluate(job));
  }

  private buildProvider(): ModelProvider {
    if (this.config.models.provider === 'mock') return new MockProvider();
    const apiKey = this.config.models.openrouterApiKey ?? resolveSecret('OPENROUTER_API_KEY');
    if (!apiKey) {
      throw new Error(
        'HOMEPILOT_MODEL_PROVIDER=openrouter but no OpenRouter key was found. ' +
          'Store it in the macOS Keychain (see README "Credentials") or set OPENROUTER_API_KEY in .env. ' +
          'To run without a key, set HOMEPILOT_MODEL_PROVIDER=mock.',
      );
    }
    return new OpenRouterProvider({ apiKey, baseUrl: this.config.models.openrouterBaseUrl });
  }

  close(): void {
    this.scheduler.stop();
    this.db.close();
  }

  private get tz(): string {
    return this.config.timezone;
  }

  // -------------------------------------------------------------------------
  // Task and reminder services
  // -------------------------------------------------------------------------

  addTask(input: NewTask, opts: { remindAt?: Date; actor?: string; correlationId?: string | null } = {}): { task: Task; reminder?: Reminder } {
    return this.db.tx(() => {
      const task = this.tasks.create(input);
      this.events.record({
        kind: 'task.created',
        actor: opts.actor ?? 'user',
        correlationId: opts.correlationId ?? null,
        subjectType: 'task',
        subjectId: task.id,
        data: { title: task.title, dueAt: task.dueAt?.toISOString() ?? null },
      });
      this.system.set('context.task', task.id);
      const reminder = opts.remindAt ? this.scheduleReminder(task.id, opts.remindAt, opts.correlationId ?? null) : undefined;
      return reminder ? { task, reminder } : { task };
    });
  }

  /** Create a reminder and its durable job in one transaction. */
  scheduleReminder(taskId: string, fireAt: Date, correlationId: string | null = null): Reminder {
    return this.db.tx(() => {
      this.tasks.require(taskId);
      const reminder = this.reminders.create(taskId, fireAt);
      this.scheduler.enqueue({
        type: 'reminder.fire',
        payload: { reminderId: reminder.id, fireAt: fireAt.toISOString() },
        runAt: fireAt,
        idempotencyKey: `reminder:${reminder.id}:${fireAt.toISOString()}`,
        correlationId,
      });
      this.events.record({
        kind: 'reminder.scheduled',
        actor: 'system',
        correlationId,
        subjectType: 'reminder',
        subjectId: reminder.id,
        data: { taskId, fireAt: fireAt.toISOString() },
      });
      return reminder;
    });
  }

  /** Snooze a task and re-remind once at `until`. Pending reminders for it are replaced. */
  snoozeTask(taskId: string, until: Date, actor = 'user'): { task: Task; reminder: Reminder } {
    return this.db.tx(() => {
      const task = this.tasks.snooze(taskId, until);
      this.reminders.cancelForTask(taskId);
      const reminder = this.scheduleReminder(taskId, until);
      this.notifier.ackForTask(taskId, 'snooze');
      this.events.record({ kind: 'task.snoozed', actor, subjectType: 'task', subjectId: taskId, data: { until: until.toISOString() } });
      return { task, reminder };
    });
  }

  completeTask(taskId: string, actor = 'user'): Task {
    return this.db.tx(() => {
      const task = this.tasks.complete(taskId);
      this.reminders.cancelForTask(taskId);
      for (const r of this.reminders.listForTask(taskId, ['fired'])) this.reminders.acknowledge(r.id);
      this.notifier.ackForTask(taskId, 'done');
      this.events.record({ kind: 'task.completed', actor, subjectType: 'task', subjectId: taskId });
      return task;
    });
  }

  /** forever=true keeps the task but stops all reminders; false removes it from the list. */
  dismissTask(taskId: string, forever: boolean, actor = 'user'): Task {
    return this.db.tx(() => {
      const task = forever ? this.tasks.setDoNotRemind(taskId, true) : this.tasks.dismiss(taskId);
      this.reminders.cancelForTask(taskId);
      this.notifier.ackForTask(taskId, forever ? 'do_not_remind' : 'dismiss');
      this.events.record({ kind: forever ? 'task.do_not_remind' : 'task.dismissed', actor, subjectType: 'task', subjectId: taskId });
      return task;
    });
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /** Run due jobs, then deliver queued notifications. The single entry point for "time passed". */
  async tick(): Promise<{ jobs: TickSummary; notifications: { sent: number; failed: number; held: number } }> {
    this.tasks.wakeDueSnoozes();
    const jobs = await this.scheduler.tick();
    const notifications = await this.notifier.dispatchPending();
    this.system.set('last_tick', this.clock.now().toISOString());
    return { jobs, notifications };
  }

  /** Make sure the recurring nudge evaluation is queued. Idempotent; safe on every start. */
  ensureNudgeLoop(): void {
    const next = this.nextNudgeSlot();
    this.scheduler.enqueue({
      type: 'nudge.evaluate',
      payload: {},
      runAt: next,
      idempotencyKey: `nudge.evaluate:${next.toISOString()}`,
      maxAttempts: 3,
    });
  }

  private nextNudgeSlot(): Date {
    const step = this.config.nudges.intervalMinutes * 60_000;
    return new Date((Math.floor(this.clock.now().getTime() / step) + 1) * step);
  }

  private async handleReminderFire(job: Job): Promise<JobResult> {
    const reminderId = String(job.payload.reminderId ?? '');
    const reminder = this.reminders.get(reminderId);
    if (!reminder) return { outcome: 'skipped', detail: 'reminder no longer exists' };
    if (reminder.state !== 'scheduled') return { outcome: 'skipped', detail: `reminder is ${reminder.state}` };
    if (reminder.fireAt.toISOString() !== job.payload.fireAt) return { outcome: 'skipped', detail: 'reminder was rescheduled' };

    const task = this.tasks.get(reminder.taskId);
    if (!task || task.state === 'done' || task.state === 'dismissed' || task.doNotRemind) {
      this.reminders.cancel(reminder.id);
      return { outcome: 'skipped', detail: 'task is closed or reminders are off for it' };
    }
    if (this.system.isPaused()) {
      return { outcome: 'defer', until: new Date(this.clock.now().getTime() + 5 * 60_000), detail: 'paused' };
    }

    const wf = this.telemetry.startWorkflow({ workflow: 'reminder.fire', feature: 'reminders', correlationId: `${job.id}:a${job.attempts}` });
    const late = this.clock.now().getTime() - reminder.fireAt.getTime() > 5 * 60_000;
    const due = task.dueAt ? ` Due ${formatLocal(task.dueAt, this.tz)}.` : '';
    const lateNote = late ? ` (This was scheduled for ${formatLocal(reminder.fireAt, this.tz)}; HomePilot was not running then.)` : '';
    const dedupeKey = `reminder:${reminder.id}:${reminder.fireAt.toISOString()}`;

    // Outbox insert + state changes commit together: a crash before commit re-runs cleanly,
    // a crash after commit finds the reminder already fired. Either way: one message.
    this.db.tx(() => {
      if (task.state === 'snoozed') this.tasks.reopen(task.id);
      const { notification } = this.notifier.enqueue({
        dedupeKey,
        kind: 'reminder',
        taskId: task.id,
        reminderId: reminder.id,
        body: `Reminder: ${task.title}.${due}${lateNote} Reply "done", "snooze 2h" or "dismiss".`,
        reason: 'you asked to be reminded at this time',
        actions: ['done', 'snooze', 'dismiss'],
        correlationId: wf.correlationId,
      });
      this.reminders.markFired(reminder.id, notification.id);
      this.tasks.noteNotified(task.id);
      this.system.set('context.task', task.id);
      this.events.record({
        kind: 'reminder.fired',
        actor: 'system',
        correlationId: wf.correlationId,
        subjectType: 'reminder',
        subjectId: reminder.id,
        data: { taskId: task.id, notificationId: notification.id, late, llmUsed: false },
      });
    });
    wf.finish({ succeeded: true, detail: 'deterministic; no model call' });
    return { outcome: 'succeeded', detail: `queued notification for "${task.title}"`, llmCalls: 0 };
  }

  private nudgePrefs(): NudgePrefs {
    const n = this.config.nudges;
    return {
      ...DEFAULT_NUDGE_PREFS,
      timezone: this.tz,
      quietStart: n.quietStart,
      quietEnd: n.quietEnd,
      maxPerDay: n.maxPerDay,
      cooldownMinutes: n.cooldownMinutes,
    };
  }

  /** Evaluate nudges right now without sending anything. */
  async evaluateNudgesNow(overrides: { prefs?: Partial<NudgePrefs>; availability?: Availability; ignoreHistory?: boolean } = {}): Promise<NudgeDecision> {
    const now = this.clock.now();
    const prefs = { ...this.nudgePrefs(), ...overrides.prefs };
    this.tasks.wakeDueSnoozes();
    const availability =
      overrides.availability ?? (await this.calendar.getAvailability(now, new Date(now.getTime() + prefs.horizonMinutes * 60_000)));
    const pending = new Set(this.reminders.listScheduled().map((r) => r.taskId));
    return evaluateNudges({
      now,
      tasks: this.tasks.list({ states: ['open', 'snoozed'] }),
      completedTaskIds: new Set(this.tasks.list({ states: ['done'] }).map((t) => t.id)),
      tasksWithPendingReminder: overrides.ignoreHistory ? new Set() : pending,
      prefs,
      nudgesSentToday: overrides.ignoreHistory ? 0 : this.notifier.countSince('nudge', startOfLocalDay(now, this.tz)),
      lastNudgeAt: overrides.ignoreHistory ? undefined : this.notifier.lastCreatedAt('nudge'),
      availability,
      paused: this.system.isPaused(),
    });
  }

  private async handleNudgeEvaluate(job: Job): Promise<JobResult> {
    const decision = await this.evaluateNudgesNow();
    this.events.record({
      kind: 'nudge.evaluated',
      actor: 'system',
      subjectType: 'job',
      subjectId: job.id,
      data: {
        decision: decision.decision,
        suppressed: decision.suppressed ?? null,
        chosenTaskId: decision.chosen?.taskId ?? null,
        candidates: decision.candidates.length,
        calendar: decision.calendarNote,
        llmUsed: false,
      },
    });

    let detail = `no nudge (${decision.suppressed})`;
    if (decision.decision === 'send' && decision.chosen) {
      const chosen = decision.chosen;
      const task = this.tasks.require(chosen.taskId);
      const wf = this.telemetry.startWorkflow({ workflow: 'nudge.send', feature: 'nudges', correlationId: `${job.id}:a${job.attempts}` });
      const msg = renderNudge(chosen);
      this.db.tx(() => {
        // Keyed on the task's notification count, so a crashed-and-re-run job cannot double-send.
        const { created } = this.notifier.enqueue({
          dedupeKey: `nudge:${task.id}:${task.notificationCount}`,
          kind: 'nudge',
          taskId: task.id,
          body: msg.body,
          reason: msg.reason,
          actions: msg.actions,
          correlationId: wf.correlationId,
        });
        if (created) {
          this.tasks.noteNotified(task.id);
          this.system.set('context.task', task.id);
        }
      });
      wf.finish({ succeeded: true, detail: 'deterministic; no model call' });
      detail = `nudged "${task.title}" (score ${chosen.score})`;
    }

    // Queue the next evaluation. Keyed by time slot, so re-runs never create duplicates.
    this.ensureNudgeLoop();
    return { outcome: 'succeeded', detail, llmCalls: 0 };
  }

  // -------------------------------------------------------------------------
  // Budget alerts
  // -------------------------------------------------------------------------

  private checkBudgetAlerts(): void {
    const ceiling = this.config.budget.monthlyUsd;
    if (ceiling <= 0) return;
    const spent = this.telemetry.monthSpendUsd({ includeSimulated: this.budgetIncludesSimulated });
    const month = inZone(this.clock.now(), this.tz).toFormat('yyyy-LL');
    for (const threshold of this.config.budget.alertThresholds) {
      if (spent / ceiling < threshold) continue;
      const key = `budget_alert:${month}:${threshold}`;
      if (!this.system.setOnce(key, this.clock.now().toISOString())) continue;
      const blocked = threshold >= 1 ? ' Model calls are now blocked until next month or until you raise the limit.' : '';
      this.notifier.enqueue({
        dedupeKey: key,
        kind: 'budget',
        body: `Model spend is at ${Math.round((spent / ceiling) * 100)}% of your $${ceiling.toFixed(2)} monthly limit ($${spent.toFixed(4)} so far).${blocked}`,
        reason: `crossed the ${Math.round(threshold * 100)}% alert threshold`,
      });
      this.events.record({ kind: 'budget.alert', actor: 'system', data: { threshold, spent, ceiling } });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound messages (the one command path; CLI, HTTP and later iMessage all use it)
  // -------------------------------------------------------------------------

  /** Say which model read the message, when one did and the setting is on. Plain code adds no note. */
  private withModelNote(reply: string, model: string | undefined): string {
    if (!model || !this.config.replyShowsModel) return reply;
    return `${reply}\n(read by ${model})`;
  }

  async handleMessage(msg: InboundMessage): Promise<MessageResult> {
    if (!this.config.allowedSenders.includes(msg.sender)) {
      // Unknown senders get no reply and can run nothing. The message text is not stored.
      this.events.record({ kind: 'message.rejected', actor: 'unknown', data: { channel: msg.channel, reason: 'sender is not on the allowlist' } });
      return { authorized: false, reply: null, correlationId: null, understoodBy: 'rejected' };
    }

    const wf = this.telemetry.startWorkflow({ workflow: 'message', feature: 'command' });
    const now = this.clock.now();
    try {
      let understoodBy: MessageResult['understoodBy'] = 'deterministic';
      let model: string | undefined;
      let cmd = parseCommand(msg.text, now, this.tz);

      if (!cmd && msg.text.trim()) {
        // Only now is a model worth paying for. It returns a classification, never an action.
        const res = await this.router.completeStructured({
          taskClass: 'fast',
          workflow: 'message',
          feature: 'intent',
          correlationId: wf.correlationId,
          system: INTENT_SYSTEM_PROMPT,
          prompt: msg.text.slice(0, 1000),
          schema: LlmIntentSchema,
        });
        if (res.ok) {
          cmd = commandFromLlm(res.value, now, this.tz);
          if (cmd) {
            understoodBy = 'model';
            model = res.model;
          }
        }
      }

      if (!cmd) {
        wf.finish({ succeeded: false, detail: 'not understood', feature: 'intent' });
        return { authorized: true, reply: `I only handle tasks and reminders, and I couldn't read that as one, so I did nothing. ${HELP}`, correlationId: wf.correlationId, understoodBy: 'not_understood' };
      }

      // An agent-relayed channel can add tasks and ask questions, but it can never approve an
      // action or lift the kill switch: those must come from the person directly.
      if (this.config.agentChannels.includes(msg.channel) && (cmd.type === 'approve' || cmd.type === 'deny' || cmd.type === 'resume')) {
        this.events.record({ kind: 'message.refused', actor: msg.sender, correlationId: wf.correlationId, data: { channel: msg.channel, command: cmd.type } });
        wf.finish({ succeeded: false, detail: `${cmd.type} refused on agent channel`, feature: 'approvals' });
        return {
          authorized: true,
          reply: this.withModelNote(
            `"${cmd.type}" can't be done through the assistant. Use the HomePilot dashboard or run it yourself in a terminal, so that only you can say yes.`,
            model,
          ),
          correlationId: wf.correlationId,
          understoodBy,
          ...(model ? { model } : {}),
          command: cmd.type,
        };
      }

      const out = await this.execute(cmd, msg, wf.correlationId);
      wf.finish({ succeeded: out.ok, detail: cmd.type, feature: out.feature });
      return {
        authorized: true,
        reply: this.withModelNote(out.reply, model),
        correlationId: wf.correlationId,
        understoodBy,
        ...(model ? { model } : {}),
        command: cmd.type,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wf.finish({ succeeded: false, detail: message });
      return { authorized: true, reply: `That failed and nothing was changed: ${message}`, correlationId: wf.correlationId, understoodBy: 'not_understood' };
    }
  }

  /** Open tasks grouped by day and sorted by time (the "tasks" reply and the dashboard). */
  agenda(): AgendaGroup[] {
    return buildAgenda(this.openTasks(), this.clock.now(), this.tz);
  }

  private openTasks(): Task[] {
    return this.tasks.list({ states: ['open', 'snoozed'] });
  }

  /** Work out which task the user means. Never guesses between equally good matches. */
  private resolveTask(ref: string | null): { task: Task } | { problem: string } {
    const open = this.openTasks();
    if (open.length === 0) return { problem: 'You have no open tasks.' };
    if (ref === null) {
      const id = this.system.get('context.task');
      const task = id ? open.find((t) => t.id === id) : undefined;
      if (task) return { task };
      if (open.length === 1) return { task: open[0]! };
      return { problem: `Which task? ${open.slice(0, 5).map((t) => `"${t.title}"`).join(', ')}.` };
    }
    const { match, ambiguous } = matchTasks(ref, open);
    if (match) return { task: match };
    if (ambiguous.length > 1) return { problem: `That matches more than one task: ${ambiguous.map((t) => `"${t.title}"`).join(', ')}. Which one?` };
    return { problem: `I couldn't find an open task matching "${ref}".` };
  }

  /** Decide due date, window and reminder time from a parsed time phrase. Pure calendar math. */
  /** Title of an open task that looks like the same thing, so a reply can point out the overlap. */
  private similarOpenTask(title: string, excludeId?: string): string | undefined {
    const open = this.openTasks().filter((t) => t.id !== excludeId);
    const { match } = matchTasks(title, open);
    return match?.title;
  }

  private planTiming(when: ParsedWhen | undefined, remind: boolean): { fields: Partial<NewTask>; remindAt?: Date; note: string } {
    const now = this.clock.now();
    const local = inZone(now, this.tz);
    const { quietStart, quietEnd } = this.config.nudges;
    const soonest = nextNonQuiet(local.plus({ hours: 1 }), quietStart, quietEnd).toJSDate();
    if (!when) {
      return {
        fields: {},
        note: remind ? ' You didn\'t give a time, so no timed reminder is set. Say "snooze that until <time>" to set one.' : '',
      };
    }
    const at = formatLocal(when.at, this.tz);

    if (when.kind === 'at') {
      if (remind || when.hasExplicitTime) {
        const picked = when.hasExplicitTime ? '' : ' (no time given, so I picked that hour)';
        return { fields: { dueAt: when.at }, remindAt: when.at, note: ` I'll remind you ${at}${picked}.` };
      }
      const endOfDay = inZone(when.at, this.tz).endOf('day').toJSDate();
      return { fields: { dueAt: endOfDay }, note: ` Due ${formatLocal(endOfDay, this.tz)}.` };
    }

    if (when.kind === 'deadline') {
      if (!remind) return { fields: { dueAt: when.at }, note: ` Due by ${at}.` };
      // Remind at 9:00 on the deadline's own day when that leaves at least 3 hours; otherwise at
      // 9:00 the day before. If that moment has already passed, about an hour from now.
      const nine = inZone(when.at, this.tz).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      const morning = (when.at.getTime() - nine.toMillis() >= 3 * 3_600_000 ? nine : nine.minus({ days: 1 })).toJSDate();
      let remindAt = morning > now ? morning : soonest;
      if (remindAt >= when.at) remindAt = new Date(Math.max(now.getTime() + 60_000, when.at.getTime() - 3_600_000));
      return { fields: { dueAt: when.at }, remindAt, note: ` Due by ${at}. I'll remind you ${formatLocal(remindAt, this.tz)}.` };
    }

    const start = when.windowStart ?? now;
    const fields: Partial<NewTask> = { windowStart: start, windowEnd: when.at };
    const range = `between ${formatLocal(start, this.tz)} and ${at}`;
    if (!remind) return { fields, note: ` I'll look for a good time ${range}.` };
    const base = inZone(start > now ? start : now, this.tz);
    const first = start > now ? nextNonQuiet(base.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }), quietStart, quietEnd).toJSDate() : soonest;
    return { fields, remindAt: first, note: ` Window: ${range}. I'll remind you ${formatLocal(first, this.tz)}.` };
  }

  private async execute(cmd: Command, msg: InboundMessage, correlationId: string): Promise<{ ok: boolean; reply: string; feature: string }> {
    switch (cmd.type) {
      case 'add_task': {
        const plan = this.planTiming(cmd.when, cmd.remind);
        const { task } = this.addTask(
          { title: cmd.title, originalRequest: msg.text.slice(0, 2000), source: msg.channel, ...plan.fields },
          { remindAt: plan.remindAt, actor: msg.sender, correlationId },
        );
        const already = this.similarOpenTask(cmd.title, task.id);
        return { ok: true, reply: `Saved "${task.title}".${plan.note}${already ? ` You also have "${already}" on your list.` : ''}`, feature: plan.remindAt ? 'reminders' : 'tasks' };
      }

      case 'add_tasks': {
        const lines: string[] = [];
        let anyReminder = false;
        for (const item of cmd.items) {
          const already = this.similarOpenTask(item.title);
          const plan = this.planTiming(item.when, item.remind);
          const { task } = this.addTask(
            { title: item.title, originalRequest: msg.text.slice(0, 2000), source: msg.channel, ...plan.fields },
            { remindAt: plan.remindAt, actor: msg.sender, correlationId },
          );
          if (plan.remindAt) anyReminder = true;
          lines.push(`${lines.length + 1}. ${task.title}.${plan.note}${already ? ` (You also have "${already}".)` : ''}`);
        }
        return { ok: true, reply: `Saved ${lines.length} tasks:\n${lines.join('\n')}`, feature: anyReminder ? 'reminders' : 'tasks' };
      }

      case 'snooze': {
        const r = this.resolveTask(cmd.ref);
        if ('problem' in r) return { ok: false, reply: r.problem, feature: 'tasks' };
        if (!cmd.when) return { ok: false, reply: `Until when should I snooze "${r.task.title}"? For example "snooze that until Saturday 10am" or "snooze 2h".`, feature: 'tasks' };
        if (cmd.when.at <= this.clock.now()) return { ok: false, reply: 'That time is in the past, so nothing was changed.', feature: 'tasks' };
        this.snoozeTask(r.task.id, cmd.when.at, msg.sender);
        return { ok: true, reply: `Snoozed "${r.task.title}" until ${formatLocal(cmd.when.at, this.tz)}. I'll remind you then, once.`, feature: 'reminders' };
      }

      case 'done': {
        const r = this.resolveTask(cmd.ref);
        if ('problem' in r) return { ok: false, reply: r.problem, feature: 'tasks' };
        this.completeTask(r.task.id, msg.sender);
        return { ok: true, reply: `Marked "${r.task.title}" done. Its reminders are cancelled.`, feature: 'tasks' };
      }

      case 'dismiss': {
        const r = this.resolveTask(cmd.ref);
        if ('problem' in r) return { ok: false, reply: r.problem, feature: 'tasks' };
        this.dismissTask(r.task.id, cmd.forever, msg.sender);
        return {
          ok: true,
          reply: cmd.forever
            ? `Okay, I won't remind you about "${r.task.title}" again. It stays on your list.`
            : `Dismissed "${r.task.title}" and removed it from your list.`,
          feature: 'tasks',
        };
      }

      case 'list': {
        const open = this.openTasks();
        if (open.length === 0) return { ok: true, reply: 'You have no open tasks.', feature: 'tasks' };
        return { ok: true, reply: renderAgenda(this.agenda()), feature: 'tasks' };
      }

      case 'suggest': {
        // The user asked, so quiet hours, caps and cooldowns do not apply. If they told us how
        // long they have, that is a fact from them; otherwise only the calendar can say.
        const now = this.clock.now();
        const stated = cmd.minutes;
        const availability: Availability | undefined = stated
          ? { status: 'ok', busy: [{ start: new Date(now.getTime() + stated * 60_000), end: new Date(now.getTime() + stated * 60_000 + 60_000) }], calendarsChecked: ['the time you said you have'] }
          : undefined;
        const d = await this.evaluateNudgesNow({
          ignoreHistory: true,
          availability,
          prefs: { quietStart: '00:00', quietEnd: '00:00', cooldownMinutes: 0, globalGapMinutes: 0, maxPerTask: Number.MAX_SAFE_INTEGER, minScore: 0, maxPerDay: Number.MAX_SAFE_INTEGER, bufferMinutes: stated ? 0 : DEFAULT_NUDGE_PREFS.bufferMinutes, horizonMinutes: stated ?? DEFAULT_NUDGE_PREFS.horizonMinutes },
        });
        if (d.suppressed === 'paused') return { ok: true, reply: 'HomePilot is paused. Say "resume" first.', feature: 'nudges' };
        if (d.suppressed === 'busy_now') return { ok: true, reply: 'Your calendar shows you are busy right now.', feature: 'nudges' };
        if (d.candidates.length === 0) return { ok: true, reply: stated ? `Nothing on your list fits in ${stated} min.` : `Nothing on your list fits right now (${d.calendarNote}).`, feature: 'nudges' };
        const top = d.candidates.slice(0, 3).map((c, i) => `${i + 1}. ${c.title}: ${c.reasons.join('; ')}`);
        const header = stated ? `For your free ${stated} min, I'd suggest:` : `Suggestions (${d.calendarNote}):`;
        return { ok: true, reply: `${header}\n${top.join('\n')}`, feature: 'nudges' };
      }

      case 'approve':
      case 'deny':
        return { ...(await this.handleApprovalReply(cmd, msg.sender)), feature: 'approvals' };

      case 'pause':
        this.system.setPaused(true);
        this.events.record({ kind: 'system.paused', actor: msg.sender, correlationId });
        return { ok: true, reply: 'Paused. No notifications will be sent and no actions will run until you say "resume". Your tasks are safe.', feature: 'system' };

      case 'resume':
        this.system.setPaused(false);
        this.events.record({ kind: 'system.resumed', actor: msg.sender, correlationId });
        return { ok: true, reply: 'Resumed.', feature: 'system' };

      case 'status': {
        const h = this.health();
        return {
          ok: true,
          reply:
            `${h.ok ? 'OK' : 'DEGRADED'}${h.paused ? ' (PAUSED)' : ''}. ${h.openTasks} open task(s), ${h.jobs.pending ?? 0} job(s) waiting, ` +
            `${h.pendingApprovals} approval(s) pending. Mode: ${h.dryRun ? 'dry-run' : 'live'}. Model: ${h.modelProvider.name}. ` +
            `Calendar: ${h.calendar.connected ? h.calendar.name : 'not connected'}.` +
            (h.problems.length ? ` Problems: ${h.problems.join('; ')}.` : ''),
          feature: 'system',
        };
      }

      case 'usage': {
        const u = this.usageReport();
        const real = u.spend.thisMonth.providerReportedUsd + u.spend.thisMonth.estimatedUsd;
        const sim = u.spend.thisMonth.simulatedUsd > 0 ? ` (plus $${u.spend.thisMonth.simulatedUsd.toFixed(6)} simulated, never billed)` : '';
        return {
          ok: true,
          reply: `This month: $${real.toFixed(4)} of $${u.budget.monthlyUsd.toFixed(2)} on models${sim}; ${u.calls.total} model call(s); ${u.workflows.deterministic} of ${u.workflows.total} workflow(s) used no model.`,
          feature: 'system',
        };
      }

      case 'help':
        return { ok: true, reply: HELP, feature: 'system' };
    }
  }

  private describeExec(res: ExecResult, approval: Approval): string {
    switch (res.status) {
      case 'succeeded':
        return res.mode === 'dry_run'
          ? `Approved. DRY-RUN only: "${approval.action}" was simulated and nothing actually happened.`
          : `Approved and done: ${approval.action}.`;
      case 'failed':
        return `Approved, but it did not happen: ${res.error}`;
      case 'denied':
        return `Not done: ${res.reason}.`;
      case 'awaiting_approval':
        return 'Still waiting for approval.';
    }
  }

  /**
   * Bind a reply to exactly one pending approval. A code always works. A bare "yes" only works
   * when there is exactly one pending request AND it is tier B; tier C always needs its code.
   */
  private async handleApprovalReply(cmd: { type: 'approve' | 'deny'; code?: string }, sender: string): Promise<{ ok: boolean; reply: string }> {
    let approval: Approval | undefined;
    if (cmd.code) {
      approval = this.approvals.getPendingByCode(cmd.code);
      if (!approval) return { ok: false, reply: `No pending approval has the code ${cmd.code}. It may have expired; nothing was done.` };
    } else {
      const pending = this.approvals.listPending();
      if (pending.length === 0) return { ok: false, reply: 'There is nothing waiting for your approval.' };
      if (pending.length > 1) {
        return { ok: false, reply: `There are ${pending.length} requests waiting. Reply with a code: ${pending.map((p) => `"${cmd.type} ${p.code}" for ${p.action}`).join('; ')}.` };
      }
      approval = pending[0]!;
      if (cmd.type === 'approve' && approval.tier === 'C') {
        return { ok: false, reply: `This one needs its code because it is a high-impact action: reply "approve ${approval.code}" to ${approval.action}.` };
      }
    }

    const decided = this.approvals.decide(approval.id, cmd.type === 'approve' ? 'approved' : 'denied', sender);
    if (!decided) return { ok: false, reply: 'That request is no longer pending (it expired or was already answered). Nothing was done.' };
    this.events.record({
      kind: `approval.${decided.state}`,
      actor: sender,
      correlationId: decided.correlationId,
      subjectType: 'approval',
      subjectId: decided.id,
      data: { tool: decided.tool, action: decided.action },
    });
    if (cmd.type === 'deny') return { ok: true, reply: `Denied: ${decided.action}. Nothing was done.` };
    const res = await this.executor.resume(decided.id, 'user');
    return { ok: res.status === 'succeeded', reply: this.describeExec(res, decided) };
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  usageReport(): UsageReport {
    return buildUsageReport({
      db: this.db,
      clock: this.clock,
      prices: this.prices,
      timezone: this.tz,
      baselineModel: this.config.budget.baselineModel,
      monthlyBudgetUsd: this.config.budget.monthlyUsd,
      alertThresholds: this.config.budget.alertThresholds,
    });
  }

  health(): Health {
    const problems: string[] = [];
    const jobs = this.scheduler.stats();
    if (jobs.dead > 0) problems.push(`${jobs.dead} job(s) failed permanently`);
    const failedNotifications = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE state = 'failed'")!.c;
    if (failedNotifications > 0) problems.push(`${failedNotifications} notification(s) could not be delivered`);
    const overdueSince = new Date(this.clock.now().getTime() - 10 * 60_000).toISOString();
    const overdue = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE state = 'pending' AND run_at < ?", overdueSince)!.c;
    if (overdue > 0) problems.push(`${overdue} job(s) are more than 10 minutes overdue (is the scheduler running?)`);
    const schemaVersion = this.db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
    const now = this.clock.now();
    return {
      ok: problems.length === 0,
      time: DateTime.fromJSDate(now, { zone: this.tz }).toISO() ?? now.toISOString(),
      timezone: this.tz,
      paused: this.system.isPaused(),
      dryRun: this.config.dryRun,
      schemaVersion,
      jobs,
      notificationsQueued: this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE state = 'queued'")!.c,
      pendingApprovals: this.approvals.listPending().length,
      openTasks: this.openTasks().length,
      lastTickAt: this.system.get('last_tick') ?? null,
      modelProvider: { name: this.provider.name, live: this.provider.via !== 'mock' },
      channel: { name: this.notifier.channelName, live: this.notifier.channelIsLive },
      calendar: { name: this.calendar.name, connected: this.calendar.name !== 'not-connected' },
      problems,
    };
  }

  /** True when local time is inside quiet hours (exposed for the CLI status view). */
  inQuietHours(): boolean {
    return isQuietHours(inZone(this.clock.now(), this.tz), this.config.nudges.quietStart, this.config.nudges.quietEnd);
  }

  newCorrelationId(): string {
    return newId('wf');
  }
}
