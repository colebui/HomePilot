import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, type AppOptions } from '../src/app.js';
import { FakeClock } from '../src/clock.js';
import { loadConfig, type Config } from '../src/config.js';
import { MockCalendar } from '../src/integrations/google-calendar/calendar.js';
import { MockProvider } from '../src/models/mock.js';
import { DryRunChannel } from '../src/notify/notifier.js';

/** Monday 2026-11-16 09:00 America/Chicago (CST, UTC-6). */
export const MONDAY_9AM = '2026-11-16T15:00:00.000Z';

export interface Harness {
  app: App;
  clock: FakeClock;
  channel: DryRunChannel;
  calendar: MockCalendar;
  provider: MockProvider;
  config: Config;
  /** Close and reopen the app on the same database file: a simulated process restart. */
  restart(): App;
  say(text: string, sender?: string): Promise<string | null>;
  cleanup(): void;
}

export function harness(opts: { env?: Record<string, string>; start?: string; file?: boolean; app?: Partial<AppOptions> } = {}): Harness {
  const dir = opts.file ? mkdtempSync(join(tmpdir(), 'homepilot-test-')) : undefined;
  const config = loadConfig({ HOMEPILOT_DB_PATH: dir ? join(dir, 'test.db') : ':memory:', ...opts.env });
  const clock = new FakeClock(opts.start ?? MONDAY_9AM);
  const channel = new DryRunChannel();
  const calendar = new MockCalendar();
  const provider = new MockProvider();
  const open = (): App => App.open({ config, clock, channel, calendar, provider, ...opts.app });
  const h: Harness = {
    app: open(),
    clock,
    channel,
    calendar,
    provider,
    config,
    restart() {
      h.app.close();
      h.app = open();
      return h.app;
    },
    async say(text, sender = 'local-cli') {
      return (await h.app.handleMessage({ sender, channel: 'test', text })).reply;
    },
    cleanup() {
      h.app.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export const at = (isoUtc: string): Date => new Date(isoUtc);
