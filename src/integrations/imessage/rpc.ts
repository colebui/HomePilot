import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Client for `imsg rpc`: JSON-RPC 2.0, one JSON object per line over the child's stdin/stdout.
 * Interface taken from the imsg docs (github.com/openclaw/imsg, docs/rpc.md) on 2026-11-17.
 * Running against a real imsg install since 2026-11-17; the tests use a fake transport.
 */
export interface ImsgTransport {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  onExit(handler: (reason: string) => void): void;
  close(): void;
}

export class ImsgRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ImsgRpcError';
  }
}

/** -32001: the send may have gone through. Retrying risks a duplicate text, so never retry blindly. */
export const MAY_HAVE_COMPLETED = -32001;
/** -32002: chat.db could not be opened, usually missing Full Disk Access. Retryable. */
export const DATABASE_UNAVAILABLE = -32002;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export class ImsgRpc implements ImsgTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  private readonly exitHandlers: ((reason: string) => void)[] = [];
  private nextId = 1;
  private closed = false;

  constructor(opts: { cliPath: string; timeoutMs?: number; spawnFn?: SpawnFn; onStderr?: (line: string) => void }) {
    const doSpawn: SpawnFn = opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.child = doSpawn(opts.cliPath, ['rpc']);
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => opts.onStderr?.(line));
    this.child.on('error', (err) => this.fail(`could not start imsg: ${err.message}`));
    this.child.on('exit', (code, signal) => this.fail(`imsg rpc exited (${signal ?? `code ${code}`})`));
  }

  private readonly timeoutMs: number;

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('imsg rpc is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`imsg ${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  onExit(handler: (reason: string) => void): void {
    this.exitHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end(); // closing stdin stops imsg rpc
    this.rejectAll(new Error('imsg rpc closed'));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours; imsg writes progress to stderr, so this should not happen
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ImsgRpcError(msg.error.message, msg.error.code, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const h of this.notificationHandlers) h(msg.method, msg.params);
  }

  private fail(reason: string): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectAll(new Error(reason));
    if (!wasClosed) for (const h of this.exitHandlers) h(reason);
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
