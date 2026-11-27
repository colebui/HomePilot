/**
 * Forward-only migrations. Never edit an applied migration: add a new one.
 * All timestamps are ISO-8601 UTC strings (lexicographically sortable).
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_schema',
    sql: `
CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  original_request   TEXT,
  category           TEXT,
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','snoozed','done','dismissed')),
  priority           INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  due_at             TEXT,
  window_start       TEXT,
  window_end         TEXT,
  estimated_minutes  INTEGER CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  recurrence         TEXT,
  depends_on         TEXT NOT NULL DEFAULT '[]',
  location           TEXT,
  energy             TEXT CHECK (energy IS NULL OR energy IN ('low','medium','high')),
  snooze_until       TEXT,
  completed_at       TEXT,
  do_not_remind      INTEGER NOT NULL DEFAULT 0,
  last_notified_at   TEXT,
  notification_count INTEGER NOT NULL DEFAULT 0,
  explanation        TEXT,
  source             TEXT NOT NULL DEFAULT 'user',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_tasks_state ON tasks(state);

CREATE TABLE reminders (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fire_at         TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','fired','acknowledged','cancelled')),
  fired_at        TEXT,
  notification_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_reminders_task ON reminders(task_id);
CREATE INDEX idx_reminders_due ON reminders(state, fire_at);

CREATE TABLE preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','default','hypothesis')),
  updated_at TEXT NOT NULL
);

-- Append-only audit trail. Never stores secrets or message bodies from third parties.
CREATE TABLE events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  correlation_id TEXT,
  kind           TEXT NOT NULL,
  actor          TEXT NOT NULL,
  subject_type   TEXT,
  subject_id     TEXT,
  data           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_kind ON events(kind, ts);
CREATE INDEX idx_events_corr ON events(correlation_id);

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL,
  tool            TEXT NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('B','C')),
  action_hash     TEXT NOT NULL,
  action          TEXT NOT NULL,
  target          TEXT,
  price_usd       REAL,
  args            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','expired','consumed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id  TEXT,
  requested_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT,
  consumed_at     TEXT
);
CREATE INDEX idx_approvals_state ON approvals(state);
CREATE INDEX idx_approvals_code ON approvals(code);

CREATE TABLE tool_executions (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tool            TEXT NOT NULL,
  tier            TEXT NOT NULL,
  action_hash     TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('dry_run','live')),
  status          TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  result          TEXT NOT NULL DEFAULT '{}',
  approval_id     TEXT,
  correlation_id  TEXT,
  ts              TEXT NOT NULL
);

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  run_at          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','dead','cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  lease_until     TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error      TEXT,
  correlation_id  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(state, run_at);

CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_type    TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('succeeded','skipped','deferred','failed','dead','recovered')),
  detail      TEXT,
  llm_calls   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_job_runs_job ON job_runs(job_id);

-- Outbox: one row per logical message. dedupe_key makes "fire once" a database guarantee.
CREATE TABLE notifications (
  id             TEXT PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  channel        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('reminder','nudge','approval','status','budget')),
  task_id        TEXT,
  reminder_id    TEXT,
  body           TEXT NOT NULL,
  reason         TEXT,
  actions        TEXT NOT NULL DEFAULT '[]',
  state          TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','failed')),
  dry_run        INTEGER NOT NULL DEFAULT 1,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  provider_ref   TEXT,
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  ack_action     TEXT,
  ack_at         TEXT,
  correlation_id TEXT
);
CREATE INDEX idx_notifications_state ON notifications(state, created_at);
CREATE INDEX idx_notifications_kind ON notifications(kind, sent_at);

-- One row per model attempt (including failures and budget blocks). No prompt or response text is stored.
CREATE TABLE llm_calls (
  id                 TEXT PRIMARY KEY,
  ts                 TEXT NOT NULL,
  correlation_id     TEXT NOT NULL,
  workflow           TEXT NOT NULL,
  feature            TEXT NOT NULL,
  task_class         TEXT NOT NULL,
  provider           TEXT NOT NULL,
  via                TEXT NOT NULL CHECK (via IN ('openrouter','direct','mock')),
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  cost_kind          TEXT NOT NULL CHECK (cost_kind IN ('provider_reported','estimated','simulated','none')),
  currency           TEXT NOT NULL DEFAULT 'USD',
  price_source       TEXT,
  price_source_ts    TEXT,
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  timed_out          INTEGER NOT NULL DEFAULT 0,
  attempt            INTEGER NOT NULL DEFAULT 1,
  is_fallback        INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT NOT NULL CHECK (outcome IN ('ok','invalid_output','error','blocked_budget')),
  error_category     TEXT,
  baseline_model     TEXT,
  baseline_cost_usd  REAL,
  baseline_price_date TEXT,
  baseline_note      TEXT
);
CREATE INDEX idx_llm_calls_ts ON llm_calls(ts);
CREATE INDEX idx_llm_calls_corr ON llm_calls(correlation_id);

-- One row per user-visible unit of work, whether or not a model was involved.
CREATE TABLE workflow_runs (
  correlation_id TEXT PRIMARY KEY,
  workflow       TEXT NOT NULL,
  feature        TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  succeeded      INTEGER,
  llm_calls      INTEGER NOT NULL DEFAULT 0,
  deterministic  INTEGER NOT NULL DEFAULT 1,
  simulated      INTEGER NOT NULL DEFAULT 0,
  detail         TEXT
);
CREATE INDEX idx_workflow_runs_started ON workflow_runs(started_at);

-- Non-LLM spend (search APIs, browser infrastructure, ...) kept separate from model spend.
CREATE TABLE other_costs (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  correlation_id TEXT,
  category       TEXT NOT NULL,
  description    TEXT,
  amount_usd     REAL NOT NULL,
  cost_kind      TEXT NOT NULL CHECK (cost_kind IN ('provider_reported','estimated','simulated')),
  currency       TEXT NOT NULL DEFAULT 'USD'
);

CREATE TABLE model_prices (
  model               TEXT PRIMARY KEY,
  input_per_mtok      REAL NOT NULL,
  output_per_mtok     REAL NOT NULL,
  cache_read_per_mtok REAL,
  source              TEXT NOT NULL,
  source_ts           TEXT NOT NULL
);

CREATE TABLE system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'imessage_inbound',
    sql: `
-- One row per incoming iMessage HomePilot has seen. The text itself is never stored.
CREATE TABLE imessage_inbound (
  guid        TEXT PRIMARY KEY,
  rowid       INTEGER NOT NULL,
  sender      TEXT NOT NULL,           -- masked, e.g. "…0100"
  allowed     INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  handled_at  TEXT
);
CREATE INDEX imessage_inbound_sender ON imessage_inbound (sender, received_at);
`,
  },
  {
    version: 3,
    name: 'expenses',
    sql: `
-- Personal expenses the owner texts in. Soft-deleted so "undo" keeps the audit trail intact.
CREATE TABLE expenses (
  id             TEXT PRIMARY KEY,
  spent_at       TEXT NOT NULL,
  amount_usd     REAL NOT NULL CHECK (amount_usd > 0),
  merchant       TEXT,
  category       TEXT NOT NULL CHECK (category IN ('groceries','dining','transport','shopping','bills','health','entertainment','other')),
  note           TEXT,
  source         TEXT NOT NULL DEFAULT 'user',
  correlation_id TEXT,
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_expenses_spent ON expenses(deleted_at, spent_at);
`,
  },
];
