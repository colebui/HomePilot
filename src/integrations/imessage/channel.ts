import type { Channel } from '../../notify/notifier.js';
import { ImsgRpcError, MAY_HAVE_COMPLETED, type ImsgTransport } from './rpc.js';

/**
 * Delivers HomePilot's own notifications (reminders, nudges, approval prompts) as an iMessage to
 * one handle: yours. It never sends to anyone else.
 *
 * Duplicates: the outbox marks a notification sent only after this returns. If imsg reports that a
 * send "may have completed" (-32001) we treat it as sent rather than risk texting you twice; a crash
 * in the instant between imsg sending and the outbox recording it can still cause one repeat.
 */
export class ImessageChannel implements Channel {
  readonly name = 'imessage';
  readonly live = true;

  constructor(
    private readonly rpc: ImsgTransport,
    private readonly toHandle: string,
  ) {}

  async deliver(message: { idempotencyKey: string; body: string; actions: string[] }): Promise<{ providerRef?: string }> {
    try {
      const res = await this.rpc.request<{ ok?: boolean; guid?: string }>('send', { to: this.toHandle, text: message.body, service: 'imessage' });
      return { providerRef: res?.guid ? `imsg:${res.guid}` : 'imsg:sent' };
    } catch (err) {
      if (err instanceof ImsgRpcError && err.code === MAY_HAVE_COMPLETED) return { providerRef: 'imsg:uncertain' };
      throw err;
    }
  }
}
