import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.js';

/**
 * Load node:sqlite without printing Node's one-line "SQLite is an experimental feature" notice
 * on every CLI command. Only that single warning is filtered; every other warning still shows.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite is an experimental feature')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}
const sqlite = loadSqlite();

export type SqlParam = string | number | bigint | null | undefined | boolean | Uint8Array;

function toSql(p: SqlParam): SQLInputValue {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

/**
 * Thin wrapper over Node's built-in SQLite (node:sqlite). No native add-on to compile,
 * so the repo installs cleanly on the Mac mini. Kept behind this class so the driver
 * can be swapped (e.g. better-sqlite3) without touching callers.
 */
export class Db {
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;
  private closed = false;

  constructor(public readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new sqlite.DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params.map(toSql));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params.map(toSql)) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params.map(toSql)) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run fn atomically. Nested calls join the outer transaction via savepoints. */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const begin = depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT sp_${depth}`;
    const commit = depth === 0 ? 'COMMIT' : `RELEASE sp_${depth}`;
    const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO sp_${depth}; RELEASE sp_${depth}`;
    this.raw.exec(begin);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      this.raw.exec(commit);
      return out;
    } catch (err) {
      this.txDepth--;
      try {
        this.raw.exec(rollback);
      } catch {
        // The original error is the one worth surfacing.
      }
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.raw.close();
  }
}

export function migrate(db: Db, nowIso: string, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  );
  const applied = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, nowIso);
    });
    ran.push(m.version);
  }
  return ran;
}

export function openDatabase(path: string, nowIso: string): Db {
  const db = new Db(path);
  migrate(db, nowIso);
  return db;
}
