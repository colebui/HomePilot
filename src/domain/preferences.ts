import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';

export type PreferenceSource = 'user' | 'default' | 'hypothesis';

export interface Preference {
  key: string;
  value: unknown;
  source: PreferenceSource;
  updatedAt: Date;
}

/**
 * Editable, structured preferences. "hypothesis" marks seeded guesses (for example travel
 * interests) that the user has not confirmed; code must treat them as editable defaults.
 */
export class PreferenceStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get<T = unknown>(key: string): T | undefined {
    const r = this.db.get<{ value: string }>('SELECT value FROM preferences WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  set(key: string, value: unknown, source: PreferenceSource = 'user'): void {
    this.db.run(
      `INSERT INTO preferences (key, value, source, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      source,
      this.clock.now().toISOString(),
    );
  }

  /** Seed a value only if the key is absent, so user edits are never overwritten. */
  seed(key: string, value: unknown, source: PreferenceSource): void {
    this.db.run(
      'INSERT OR IGNORE INTO preferences (key, value, source, updated_at) VALUES (?, ?, ?, ?)',
      key,
      JSON.stringify(value),
      source,
      this.clock.now().toISOString(),
    );
  }

  delete(key: string): boolean {
    return this.db.run('DELETE FROM preferences WHERE key = ?', key).changes > 0;
  }

  list(): Preference[] {
    return this.db
      .all<{ key: string; value: string; source: PreferenceSource; updated_at: string }>(
        'SELECT * FROM preferences ORDER BY key',
      )
      .map((r) => ({ key: r.key, value: JSON.parse(r.value), source: r.source, updatedAt: new Date(r.updated_at) }));
  }
}

/** Small key/value store for operational flags (kill switch, alert markers, conversation context). */
export class SystemState {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM system_state WHERE key = ?', key)?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      this.clock.now().toISOString(),
    );
  }

  /** Set only if absent. Returns true when this call created the key (useful for "alert once"). */
  setOnce(key: string, value: string): boolean {
    return (
      this.db.run(
        'INSERT OR IGNORE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)',
        key,
        value,
        this.clock.now().toISOString(),
      ).changes === 1
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM system_state WHERE key = ?', key);
  }

  /** Emergency pause: no notifications are delivered and no tool side effects are authorized. */
  isPaused(): boolean {
    return this.get('paused') === '1';
  }

  setPaused(paused: boolean): void {
    this.set('paused', paused ? '1' : '0');
  }
}
