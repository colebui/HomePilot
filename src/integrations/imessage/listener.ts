import type { App } from '../../app.js';
import { matchAllowed, maskHandle } from './handles.js';
import { ImsgRpcError, MAY_HAVE_COMPLETED, type ImsgTransport } from './rpc.js';

/** The fields of an imsg message that HomePilot uses (imsg docs/json.md). */
export interface ImsgMessage {
  id: number;
  chat_id?: number;
  guid?: string;
  sender?: string;
  is_from_me?: boolean;
  is_group?: boolean;
  text?: string | null;
  created_at?: string;
  /** Present only on live updates to an existing message: "edited" or "unsent". */
  type?: string;
}

export interface ListenerOptions {
  /** true = read and act on texts but do not send replies; replies are logged instead. */
  dryRun: boolean;
  /** Cap on texts handled per sender per rolling hour, against loops and floods. */
  maxPerHour: number;
  log?: (line: string) => void;
}

const CURSOR_KEY = 'imessage.cursor';

/**
 * Turns incoming iMessages into HomePilot commands and texts the reply back.
 *
 * - Only one-to-one chats, only messages not sent by this Mac, only allowlisted senders.
 *   Anyone else gets no reply at all, and their text is never stored.
 * - At most once: a message's guid is recorded before it is handled, so a crash mid-way can drop a
 *   command but can never run it twice.
 * - Resumes from the last handled message after a restart, and does not replay older history on
 *   first start.
 */
export class ImessageListener {
  private subscription: number | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly rpc: ImsgTransport,
    private readonly opts: ListenerOptions,
  ) {}

  async start(): Promise<void> {
    await this.rpc.request('initialize', { protocol_version: 1 });
    const status = await this.rpc.request<{ database?: { ready?: boolean } }>('status');
    if (status?.database?.ready === false) {
      throw new Error('imsg cannot read the Messages database. Give Full Disk Access to the app that starts HomePilot (Terminal, or node for the launchd service), then restart it.');
    }
    this.rpc.onNotification((method, params) => {
      // Handle strictly one at a time, in arrival order.
      this.queue = this.queue.then(() => this.onNotification(method, params)).catch((err) => this.log(`error: ${errText(err)}`));
    });
    await this.subscribe();
  }

  /** Wait until every message received so far has been handled. For tests and clean shutdown. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async subscribe(): Promise<void> {
    const cursor = this.app.system.get(CURSOR_KEY);
    const params: Record<string, unknown> = {};
    if (cursor) params.since_rowid = Number(cursor);
    const res = await this.rpc.request<{ subscription: number }>('watch.subscribe', params);
    this.subscription = res.subscription;
    this.log(cursor ? `listening for texts after message ${cursor}` : 'listening for new texts');
  }

  private async onNotification(method: string, params: unknown): Promise<void> {
    const p = (params ?? {}) as { subscription?: number; message?: ImsgMessage; resume_after_rowid?: number };
    if (this.subscription !== undefined && p.subscription !== undefined && p.subscription !== this.subscription) return;
    if (method === 'message' && p.message) {
      await this.handle(p.message);
    } else if (method === 'watch.overflow') {
      // imsg dropped its buffer. Resubscribe from where it says; duplicates are possible and the
      // guid check below absorbs them.
      if (p.resume_after_rowid !== undefined) this.app.system.set(CURSOR_KEY, String(p.resume_after_rowid));
      this.log('watch buffer overflowed; resubscribing');
      await this.subscribe();
    }
  }

  /** Exposed for tests. */
  async handle(m: ImsgMessage): Promise<void> {
    const advance = (): void => {
      const cur = Number(this.app.system.get(CURSOR_KEY) ?? 0);
      if (m.id > cur) this.app.system.set(CURSOR_KEY, String(m.id));
    };
    if (m.is_from_me || m.is_group || m.type || !m.sender || !m.text?.trim()) return advance();

    const allowed = matchAllowed(m.sender, this.app.config.allowedSenders);
    const guid = m.guid ?? `rowid:${m.id}`;
    // Record before acting: if this guid was seen before, stop (at most once).
    const fresh = this.app.db.run(
      'INSERT OR IGNORE INTO imessage_inbound (guid, rowid, sender, allowed, received_at) VALUES (?, ?, ?, ?, ?)',
      guid,
      m.id,
      maskHandle(m.sender),
      allowed ? 1 : 0,
      this.app.clock.now().toISOString(),
    ).changes === 1;
    advance();
    if (!fresh) return;

    if (!allowed) {
      // Same treatment as any unknown sender: no reply, nothing run, text not stored.
      await this.app.handleMessage({ sender: m.sender, channel: 'imessage', text: m.text });
      return;
    }

    const hourAgo = new Date(this.app.clock.now().getTime() - 3_600_000).toISOString();
    const recent = this.app.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM imessage_inbound WHERE sender = ? AND allowed = 1 AND handled_at IS NOT NULL AND received_at > ?',
      maskHandle(m.sender),
      hourAgo,
    )!.c;
    if (recent >= this.opts.maxPerHour) {
      this.app.events.record({ kind: 'imessage.rate_limited', actor: 'system', data: { sender: maskHandle(m.sender) } });
      return;
    }

    const result = await this.app.handleMessage({ sender: allowed, channel: 'imessage', text: m.text });
    this.app.db.run('UPDATE imessage_inbound SET handled_at = ? WHERE guid = ?', this.app.clock.now().toISOString(), guid);
    if (!result.reply) return;

    if (this.opts.dryRun) {
      this.log(`(dry-run, not sent) reply to ${maskHandle(m.sender)}: ${result.reply}`);
      return;
    }
    const target: Record<string, unknown> = m.chat_id !== undefined ? { chat_id: m.chat_id } : { to: m.sender };
    try {
      await this.rpc.request('send', { ...target, text: result.reply });
    } catch (err) {
      if (err instanceof ImsgRpcError && err.code === MAY_HAVE_COMPLETED) return; // probably delivered; never resend
      this.app.events.record({ kind: 'imessage.reply_failed', actor: 'system', data: { sender: maskHandle(m.sender), error: errText(err) } });
      this.log(`could not send reply: ${errText(err)}`);
    }
  }

  stop(): void {
    this.rpc.close();
  }

  private log(line: string): void {
    this.opts.log?.(`[imessage] ${line}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
