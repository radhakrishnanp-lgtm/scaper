import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "./env";
import { log } from "./log";

/**
 * All storage lives in one SQLite file. Every query goes through prepared
 * statements in src/server/repo, so swapping to Postgres later means
 * rewriting that folder only.
 */
const MIGRATIONS: { id: number; name: string; sql: string; foreignKeysOff?: boolean }[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  url TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('browser','fast')),
  extract TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scrape_runs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error','blocked')),
  extract TEXT NOT NULL,
  result TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runs_created ON scrape_runs(created_at DESC);
CREATE INDEX idx_runs_recipe ON scrape_runs(recipe_id, created_at DESC);

CREATE TABLE watchers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('browser','fast')),
  target TEXT NOT NULL,
  condition TEXT NOT NULL,
  notify TEXT NOT NULL,
  ignore_lines TEXT NOT NULL DEFAULT '[]',
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  next_check_at TEXT,
  last_status TEXT,
  last_error TEXT,
  last_value REAL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  check_count INTEGER NOT NULL DEFAULT 0,
  change_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_watchers_due ON watchers(enabled, next_check_at);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  value REAL,
  changed INTEGER NOT NULL DEFAULT 0,
  triggered INTEGER NOT NULL DEFAULT 0,
  diff TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_snapshots_watcher ON snapshots(watcher_id, created_at DESC);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  image TEXT,
  currency TEXT,
  current_price REAL,
  list_price REAL,
  rating REAL,
  review_count INTEGER,
  in_stock INTEGER,
  target_price REAL,
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  next_check_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_due ON products(enabled, next_check_at);

CREATE TABLE price_points (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  list_price REAL,
  in_stock INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prices_product ON price_points(product_id, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  watcher_id TEXT REFERENCES watchers(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(read_at);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','error')),
  steps TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_created ON agent_runs(created_at DESC);

CREATE TABLE ai_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_event_log_created ON event_log(created_at DESC);
`,
  },
  {
    id: 2,
    name: "scheduled_recipes",
    sql: `
ALTER TABLE recipes ADD COLUMN schedule_minutes INTEGER CHECK (schedule_minutes IS NULL OR schedule_minutes >= 15);
ALTER TABLE recipes ADD COLUMN next_run_at TEXT;
ALTER TABLE recipes ADD COLUMN last_run_at TEXT;
ALTER TABLE recipes ADD COLUMN last_status TEXT;
CREATE INDEX idx_recipes_due ON recipes(schedule_minutes, next_run_at);
`,
  },
  {
    id: 3,
    name: "enterprise",
    sql: `
ALTER TABLE recipes ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE recipes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE recipes ADD COLUMN cron TEXT;
ALTER TABLE recipes ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;

-- Rebuilt to allow partial and cancelled runs, and to link runs to jobs.
CREATE TABLE scrape_runs_v3 (
  id TEXT PRIMARY KEY,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  job_id TEXT,
  url TEXT NOT NULL,
  final_url TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','partial','error','blocked','cancelled')),
  extract TEXT NOT NULL,
  result TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO scrape_runs_v3 (id, recipe_id, url, final_url, mode, status, extract, result, row_count, error, duration_ms, created_at)
  SELECT id, recipe_id, url, final_url, mode, status, extract, result, row_count, error, duration_ms, created_at FROM scrape_runs;
DROP TABLE scrape_runs;
ALTER TABLE scrape_runs_v3 RENAME TO scrape_runs;
CREATE INDEX idx_runs_created ON scrape_runs(created_at DESC);
CREATE INDEX idx_runs_recipe ON scrape_runs(recipe_id, created_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  trigger TEXT NOT NULL DEFAULT 'manual',
  input TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_queue ON jobs(status, priority DESC, run_after);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_jobs_ref ON jobs(ref_id, created_at DESC);

CREATE TABLE job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_job_logs_job ON job_logs(job_id, id);

ALTER TABLE watchers ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE watchers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE watchers ADD COLUMN last_notified_at TEXT;
ALTER TABLE watchers ADD COLUMN last_change_at TEXT;
ALTER TABLE snapshots ADD COLUMN screenshot TEXT;
ALTER TABLE snapshots ADD COLUMN visual_diff TEXT;
ALTER TABLE snapshots ADD COLUMN visual_change REAL;
ALTER TABLE snapshots ADD COLUMN verdict TEXT;
ALTER TABLE snapshots ADD COLUMN status_code INTEGER;
ALTER TABLE snapshots ADD COLUMN response_ms INTEGER;
ALTER TABLE watchers ADD COLUMN error_alerted_at TEXT;

CREATE TABLE task_seen (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (recipe_id, key)
);

ALTER TABLE products ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN alerts TEXT NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN group_name TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN data TEXT;

CREATE TABLE deal_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  rank_with_ai INTEGER NOT NULL DEFAULT 0,
  schedule_minutes INTEGER CHECK (schedule_minutes IS NULL OR schedule_minutes >= 30),
  notify_new INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_count INTEGER,
  last_result TEXT,
  seen TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deal_searches_due ON deal_searches(schedule_minutes, next_run_at);

CREATE TABLE site_rules (
  host TEXT PRIMARY KEY,
  delay_seconds REAL,
  mode TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '[]',
  cookies TEXT NOT NULL DEFAULT '',
  respect_robots INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE host_stats (
  host TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_at TEXT,
  PRIMARY KEY (host, day)
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

ALTER TABLE ai_usage ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 4,
    name: "agent_follow_ups",
    sql: `
ALTER TABLE agent_runs ADD COLUMN parent_id TEXT;
CREATE INDEX idx_agent_parent ON agent_runs(parent_id);
`,
  },
  {
    id: 5,
    name: "ai_gateway",
    sql: `
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  ref_id TEXT,
  provider_id TEXT,
  provider_name TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error','cached')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  fallback_from TEXT,
  error TEXT,
  request TEXT,
  response TEXT
);
CREATE INDEX idx_ai_calls_created ON ai_calls(created_at DESC);
CREATE INDEX idx_ai_calls_ref ON ai_calls(ref_id);

CREATE TABLE ai_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_memory (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'you' CHECK (source IN ('you','agent')),
  created_at TEXT NOT NULL
);

ALTER TABLE ai_usage ADD COLUMN cost REAL NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cost REAL NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN pending TEXT;
ALTER TABLE agent_runs ADD COLUMN model_label TEXT;
`,
  },
  {
    id: 6,
    name: "operations",
    sql: `
-- Every saved change of a task or watcher, so a run can say which setup it used and you can roll back.
ALTER TABLE recipes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recipes ADD COLUMN health_alerted_at TEXT;
ALTER TABLE watchers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE config_versions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('task','watcher')),
  ref_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref_id, version)
);
CREATE INDEX idx_versions_ref ON config_versions(kind, ref_id, version DESC);

-- What went wrong (cause, evidence, next step) and the validation score of each run.
ALTER TABLE scrape_runs ADD COLUMN version INTEGER;
ALTER TABLE scrape_runs ADD COLUMN diagnosis TEXT;
ALTER TABLE scrape_runs ADD COLUMN score REAL;
ALTER TABLE scrape_runs ADD COLUMN validation TEXT;

-- Validation problems tracked across runs: new when a rule starts failing, resolved when it passes again.
CREATE TABLE quality_issues (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  label TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warn','fail')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  detail TEXT NOT NULL,
  first_run_id TEXT,
  last_run_id TEXT,
  runs INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_quality_issues ON quality_issues(recipe_id, status, last_seen DESC);

-- Repairs prepared by the AI when a task breaks: applied on their own or waiting for you.
CREATE TABLE heal_proposals (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','dismissed','failed')),
  reason TEXT NOT NULL,
  extract TEXT,
  report TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_heal_recipe ON heal_proposals(recipe_id, created_at DESC);

-- Change triage: importance (AI or you), reviewed, and your feedback.
ALTER TABLE snapshots ADD COLUMN important INTEGER;
ALTER TABLE snapshots ADD COLUMN summary TEXT;
ALTER TABLE snapshots ADD COLUMN reviewed_at TEXT;
ALTER TABLE snapshots ADD COLUMN feedback TEXT;
CREATE INDEX idx_snapshots_changes ON snapshots(changed, created_at DESC);

-- Outgoing webhooks and Google Sheets syncs: every attempt, its response, and retries.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('webhook','sheets')),
  target TEXT NOT NULL,
  target_name TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ok','retrying','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  response_body TEXT,
  error TEXT,
  latency_ms INTEGER,
  next_attempt_at TEXT,
  ref_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliveries_created ON deliveries(created_at DESC);
CREATE INDEX idx_deliveries_due ON deliveries(status, next_attempt_at);

-- Saved table views (columns, filters, sort) per dataset.
CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_saved_views_scope ON saved_views(scope, created_at);
`,
  },
  {
    id: 7,
    name: "agent_teams",
    sql: `
-- Helper agents a supervisor run starts: the instructions it wrote for each, what they did and what they found.
CREATE TABLE agent_workers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  task TEXT NOT NULL,
  examples TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  questions TEXT,
  model TEXT NOT NULL DEFAULT 'fast',
  playbook_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','done','error','stopped')),
  steps TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);
CREATE INDEX idx_workers_team ON agent_workers(team_id, created_at);

-- The team's shared memory: notes any agent in the team writes and every agent can read.
CREATE TABLE team_memory (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_team_memory ON team_memory(team_id, created_at);

-- Instructions, examples and decision questions the supervisor wrote and keeps improving, per kind of job.
CREATE TABLE agent_playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  examples TEXT NOT NULL DEFAULT '',
  questions TEXT,
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','you')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 8,
    name: "agent_knowledge",
    sql: `
-- The agent's own Markdown notes: how-tos, site notes and lessons it writes and keeps improving.
-- Also mirrored as .md files in data/knowledge so you can open them in any editor.
CREATE TABLE agent_notes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'how-to' CHECK (kind IN ('how-to','site','lesson','reference')),
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','you')),
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The agent's review of its own finished runs: a score, what went wrong and the lesson it took.
CREATE TABLE agent_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  summary TEXT NOT NULL,
  problems TEXT NOT NULL DEFAULT '[]',
  lesson TEXT NOT NULL DEFAULT '',
  note_name TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_created ON agent_reviews(created_at);
`,
  },
  {
    id: 9,
    name: "bots",
    sql: `
-- Your own bots: a name, a job, instructions, when to run (schedule and/or events), what they may do
-- and where they tell you. Each run is an agent run with bot_id set.
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL DEFAULT '🤖',
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_id TEXT,
  last_status TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  finished_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bots_due ON bots(enabled, next_run_at);

-- Each bot's own memory: facts it keeps between runs, plus a short summary of each run.
CREATE TABLE bot_memory (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','run')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, kind, key)
);
CREATE INDEX idx_bot_memory ON bot_memory(bot_id, kind, updated_at DESC);

-- External alerts held during quiet hours; sent when quiet hours end.
CREATE TABLE held_alerts (
  id TEXT PRIMARY KEY,
  alert TEXT NOT NULL,
  channels TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE agent_runs ADD COLUMN bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN trigger TEXT;
CREATE INDEX idx_agent_bot ON agent_runs(bot_id, created_at DESC);
`,
  },
  {
    id: 10,
    name: "downloads, pause and resume, bot evaluations",
    // Rebuilds jobs (a new 'paused' status) without touching job_logs, so foreign keys are off for this one.
    foreignKeysOff: true,
    sql: `
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','succeeded','failed','cancelled')),
  trigger TEXT NOT NULL DEFAULT 'manual',
  input TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  -- Where a paused or interrupted task run stopped (its queue, the pages done and the rows so far).
  checkpoint TEXT
);
INSERT INTO jobs_new (id, kind, ref_id, title, status, trigger, input, progress, result, error, attempts, max_attempts, priority, run_after, created_at, started_at, finished_at)
  SELECT id, kind, ref_id, title, status, trigger, input, progress, result, error, attempts, max_attempts, priority, run_after, created_at, started_at, finished_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX idx_jobs_queue ON jobs(status, priority DESC, run_after);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_jobs_ref ON jobs(ref_id, created_at DESC);

-- Bot memory gains lessons: what the bot's self-evaluations learned.
CREATE TABLE bot_memory_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','run','lesson')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, kind, key)
);
INSERT INTO bot_memory_new SELECT id, bot_id, kind, key, value, created_at, updated_at FROM bot_memory;
DROP TABLE bot_memory;
ALTER TABLE bot_memory_new RENAME TO bot_memory;
CREATE INDEX idx_bot_memory ON bot_memory(bot_id, kind, updated_at DESC);

-- A bot's grade of each of its runs, and your thumbs up or down with a note.
CREATE TABLE bot_evals (
  run_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  score INTEGER,
  met_job INTEGER,
  summary TEXT,
  lessons TEXT NOT NULL DEFAULT '[]',
  suggestion TEXT,
  user_rating INTEGER NOT NULL DEFAULT 0,
  user_note TEXT NOT NULL DEFAULT '',
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bot_evals ON bot_evals(bot_id, created_at DESC);

-- The download manager: one row per file, with progress so a paused or interrupted download resumes.
CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  path TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','done','failed','cancelled')),
  bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  content_type TEXT,
  resumable INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  ref_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_downloads_status ON downloads(status, created_at);
CREATE INDEX idx_downloads_created ON downloads(created_at DESC);
`,
  },
];

function migrate(db: Database.Database, upTo = Infinity) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare("SELECT id FROM _migrations").all().map((r) => (r as { id: number }).id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id) || m.id > upTo) continue;
    // A table rebuild must not cascade deletes into the tables that point at it; the pragma only works outside a transaction.
    if (m.foreignKeysOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const broken = db.pragma("foreign_key_check") as unknown[];
          if (broken.length) throw new Error(`Migration ${m.id} left ${broken.length} broken reference(s).`);
        }
        db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
      })();
    } finally {
      if (m.foreignKeysOff) db.pragma("foreign_keys = ON");
    }
    log.info("db.migrated", { id: m.id, name: m.name });
  }
}

/** `upTo` stops at an older schema version, for migration tests. */
export function openDatabase(file: string, upTo?: number) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Deleted rows are overwritten, so "wipe history" and private runs leave nothing readable in the file.
  db.pragma("secure_delete = ON");
  migrate(db, upTo);
  return db;
}

// Survive Next.js hot reloads in dev: one connection per process.
const g = globalThis as unknown as { __scaperDb?: Database.Database };

export function db(): Database.Database {
  if (!g.__scaperDb) g.__scaperDb = openDatabase(path.join(env.dataDir, "scaper.db"));
  return g.__scaperDb;
}

/** For tests: point the app at a fresh database. */
export function setDatabaseForTests(instance: Database.Database) {
  g.__scaperDb = instance;
}
