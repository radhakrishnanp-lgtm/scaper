import "server-only";
import { Cron } from "croner";
import { db } from "../db";
import { isPrivate } from "../privacy";
import { ephemeral } from "./ephemeral";
import { defaultTaskOptions, taskOptionsSchema, type ExtractSpec, type FetchMode, type TaskInput, type TaskOptions } from "@/lib/schemas";
import { newId, now, pageSize, parseJson } from "./util";
import { deleteVersions, ensureBaseline, recordVersion, type VersionSource } from "./versions";

export type { Dataset, ScrapeResult } from "@/lib/types";
import type { Diagnosis, ScrapeResult } from "@/lib/types";

/** Tasks are stored in the `recipes` table (their first name), so older saved recipes keep working. */
type RecipeRow = {
  id: string; name: string; description: string; url: string; mode: FetchMode; extract: string; options: string; tags: string;
  created_at: string; updated_at: string; schedule_minutes: number | null; cron: string | null;
  next_run_at: string | null; last_run_at: string | null; last_status: string | null; run_count: number;
  version: number; health_alerted_at: string | null;
};
export type Recipe = Omit<RecipeRow, "extract" | "options" | "tags"> & { extract: ExtractSpec; options: TaskOptions; tags: string[] };
export type Task = Recipe;

const toRecipe = (r: RecipeRow): Recipe => {
  const parsed = taskOptionsSchema.safeParse(parseJson(r.options, {}));
  return {
    ...r,
    extract: parseJson<ExtractSpec>(r.extract, { type: "auto" }),
    options: parsed.success ? parsed.data : defaultTaskOptions(),
    tags: parseJson<string[]>(r.tags, []),
  };
};

/** Next run time for a schedule: cron wins over an interval; null means manual only. */
export function nextRunAt(minutes: number | null | undefined, cron: string | null | undefined, from = new Date()): string | null {
  if (cron) {
    const next = new Cron(cron, { paused: true }).nextRun(from);
    return next ? next.toISOString() : null;
  }
  return minutes ? new Date(from.getTime() + minutes * 60_000).toISOString() : null;
}

/** Throws a readable error for a cron expression croner can't parse. */
export function validateCron(cron: string | null | undefined) {
  if (!cron) return;
  try {
    new Cron(cron, { paused: true }).nextRun();
  } catch (e) {
    throw new Error(`Invalid cron schedule: ${(e as Error).message}`);
  }
}

export function listRecipes(opts: { q?: string; tag?: string } = {}): Recipe[] {
  let rows = (db().prepare("SELECT * FROM recipes ORDER BY updated_at DESC LIMIT 500").all() as RecipeRow[]).map(toRecipe);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }
  if (opts.tag) rows = rows.filter((r) => r.tags.includes(opts.tag!));
  return rows;
}

export function getRecipe(id: string): Recipe | null {
  const r = db().prepare("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | undefined;
  return r ? toRecipe(r) : null;
}

type RecipeInput = Omit<TaskInput, "description" | "options" | "tags" | "cron"> & Partial<Pick<TaskInput, "description" | "options" | "tags" | "cron">>;

/** What a task version stores: everything you can edit, in the shape the task API accepts. */
export function taskVersionData(r: Recipe): TaskInput {
  return { name: r.name, description: r.description, url: r.url, mode: r.mode, extract: r.extract, options: r.options, tags: r.tags, scheduleMinutes: r.schedule_minutes, cron: r.cron };
}

export function createRecipe(input: RecipeInput): Recipe {
  validateCron(input.cron);
  const id = newId();
  const t = now();
  // First scheduled run a minute from now, so a new schedule proves itself quickly.
  const first = input.cron ? nextRunAt(null, input.cron) : input.scheduleMinutes ? new Date(Date.now() + 60_000).toISOString() : null;
  db().prepare(
    `INSERT INTO recipes (id, name, description, url, mode, extract, options, tags, schedule_minutes, cron, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.description ?? "", input.url, input.mode, JSON.stringify(input.extract), JSON.stringify(input.options ?? defaultTaskOptions()),
    JSON.stringify(input.tags ?? []), input.scheduleMinutes ?? null, input.cron ?? null, first, t, t);
  recordVersion("task", id, taskVersionData(getRecipe(id)!), "create");
  return getRecipe(id)!;
}

export function updateRecipe(id: string, input: RecipeInput, change: { source?: VersionSource; note?: string } = {}) {
  validateCron(input.cron);
  const before = getRecipe(id);
  if (!before) return null;
  ensureBaseline("task", id, () => taskVersionData(before));
  const schedule = input.scheduleMinutes ?? null;
  const cron = input.cron ?? null;
  // Keep the existing slot unless the schedule itself changed.
  const same = schedule === before.schedule_minutes && cron === before.cron;
  const next = same ? before.next_run_at : cron ? nextRunAt(null, cron) : schedule ? new Date(Date.now() + 60_000).toISOString() : null;
  db().prepare(
    `UPDATE recipes SET name = ?, description = ?, url = ?, mode = ?, extract = ?, options = ?, tags = ?, schedule_minutes = ?, cron = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.name, input.description ?? before.description, input.url, input.mode, JSON.stringify(input.extract),
    JSON.stringify(input.options ?? before.options), JSON.stringify(input.tags ?? before.tags), schedule, cron, next, now(), id);
  const after = getRecipe(id)!;
  recordVersion("task", id, taskVersionData(after), change.source ?? "edit", change.note);
  return getRecipe(id);
}

export function setRecipeSchedulePaused(id: string, paused: boolean) {
  const r = getRecipe(id);
  if (!r) return null;
  db().prepare("UPDATE recipes SET next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(paused ? null : nextRunAt(r.schedule_minutes, r.cron), now(), id);
  return getRecipe(id);
}

export function duplicateRecipe(id: string) {
  const r = getRecipe(id);
  if (!r) return null;
  return createRecipe({ ...r, name: `${r.name} (copy)`.slice(0, 120), scheduleMinutes: null, cron: null });
}

/** Scheduler: claims tasks whose run is due by pushing their slot forward. */
export function claimDueRecipes(limit: number): Recipe[] {
  if (limit <= 0) return [];
  const t = now();
  return db().transaction(() => {
    const rows = db().prepare(
      "SELECT * FROM recipes WHERE (schedule_minutes IS NOT NULL OR cron IS NOT NULL) AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
    ).all(t, limit) as RecipeRow[];
    const stmt = db().prepare("UPDATE recipes SET next_run_at = ? WHERE id = ?");
    for (const r of rows) {
      let next: string | null;
      try { next = nextRunAt(r.schedule_minutes, r.cron); } catch { next = null; }
      stmt.run(next, r.id);
    }
    return rows.map(toRecipe);
  })();
}

export function recordRecipeRun(id: string, status: string) {
  db().prepare("UPDATE recipes SET last_run_at = ?, last_status = ?, run_count = run_count + 1 WHERE id = ?").run(now(), status, id);
}

export function deleteRecipe(id: string) {
  deleteVersions("task", id);
  return db().prepare("DELETE FROM recipes WHERE id = ?").run(id).changes > 0;
}

export function setHealthAlerted(id: string, at: string | null) {
  db().prepare("UPDATE recipes SET health_alerted_at = ? WHERE id = ?").run(at, id);
}

export type RunStatus = "ok" | "partial" | "error" | "blocked" | "cancelled";

type RunRow = {
  id: string; recipe_id: string | null; job_id: string | null; url: string; final_url: string | null; mode: FetchMode;
  status: RunStatus; extract: string; result: string | null; row_count: number; page_count: number;
  error: string | null; duration_ms: number; created_at: string;
  version: number | null; diagnosis: string | null; score: number | null; validation: string | null;
};
/** Validation outcome kept outside the (large) result, for lists and health charts. */
export type RunValidationSummary = { status: "pass" | "warn" | "fail" | "none"; score: number | null; failed: number; warned: number; opened?: number; resolved?: number };
export type ScrapeRun = Omit<RunRow, "extract" | "result" | "diagnosis" | "validation"> & {
  extract: ExtractSpec; result: ScrapeResult | null; recipe_name?: string | null; private?: boolean;
  diagnosis: Diagnosis | null; validation: RunValidationSummary | null;
};

const toRun = (r: RunRow): ScrapeRun => ({
  ...r,
  extract: parseJson<ExtractSpec>(r.extract, { type: "auto" }),
  result: parseJson<ScrapeResult | null>(r.result, null),
  diagnosis: parseJson<Diagnosis | null>(r.diagnosis, null),
  validation: parseJson<RunValidationSummary | null>(r.validation, null),
});

// Private runs: kept in memory for an hour, never written to the database.
const privateRuns = ephemeral<ScrapeRun>("runs", 60 * 60_000, 50);

type SaveRunInput = Omit<ScrapeRun, "id" | "created_at" | "job_id" | "page_count" | "version" | "diagnosis" | "score" | "validation"> & {
  job_id?: string | null; page_count?: number; version?: number | null; diagnosis?: Diagnosis | null; score?: number | null; validation?: RunValidationSummary | null;
};

export function saveRun(input: SaveRunInput): ScrapeRun {
  const id = newId();
  const full = { ...input, version: input.version ?? null, diagnosis: input.diagnosis ?? null, score: input.score ?? null, validation: input.validation ?? null };
  if (isPrivate()) {
    return privateRuns.set(id, { ...full, id, job_id: input.job_id ?? null, page_count: input.page_count ?? 1, created_at: now(), private: true });
  }
  db().prepare(
    `INSERT INTO scrape_runs (id, recipe_id, job_id, url, final_url, mode, status, extract, result, row_count, page_count, error, duration_ms, created_at, version, diagnosis, score, validation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.recipe_id, input.job_id ?? null, input.url, input.final_url, input.mode, input.status, JSON.stringify(input.extract),
    input.result ? JSON.stringify(input.result) : null, input.row_count, input.page_count ?? 1, input.error, input.duration_ms, now(),
    full.version, full.diagnosis ? JSON.stringify(full.diagnosis) : null, full.score, full.validation ? JSON.stringify(full.validation) : null,
  );
  return getRun(id)!;
}

/** Issues are tracked after the run is saved, so the new/resolved counts are added afterwards. */
export function setRunValidation(id: string, summary: RunValidationSummary) {
  const p = privateRuns.get(id);
  if (p) { p.validation = summary; return; }
  db().prepare("UPDATE scrape_runs SET validation = ? WHERE id = ?").run(JSON.stringify(summary), id);
}

/** Row counts of recent good runs, for the usual-range band. */
export function recentGoodCounts(recipeId: string, limit = 14): number[] {
  return (db().prepare("SELECT row_count FROM scrape_runs WHERE recipe_id = ? AND status IN ('ok','partial') AND row_count > 0 ORDER BY created_at DESC LIMIT ?")
    .all(recipeId, limit) as { row_count: number }[]).map((r) => r.row_count);
}

/** Newest runs first, without results: health charts and failure streaks. */
export function runHistory(recipeId: string, limit = 200) {
  return db().prepare(
    `SELECT id, job_id, status, row_count, page_count, duration_ms, created_at, version, score, error, diagnosis, validation
     FROM scrape_runs WHERE recipe_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(recipeId, limit) as { id: string; job_id: string | null; status: RunStatus; row_count: number; page_count: number; duration_ms: number; created_at: string; version: number | null; score: number | null; error: string | null; diagnosis: string | null; validation: string | null }[];
}

export function getRun(id: string): ScrapeRun | null {
  const p = privateRuns.get(id);
  if (p) return p;
  const r = db().prepare("SELECT * FROM scrape_runs WHERE id = ?").get(id) as RunRow | undefined;
  return r ? toRun(r) : null;
}

/** The newest run of a task that produced data, for "what's new since last time". */
export function lastGoodRun(recipeId: string): ScrapeRun | null {
  const r = db().prepare("SELECT * FROM scrape_runs WHERE recipe_id = ? AND status IN ('ok','partial') AND row_count > 0 ORDER BY created_at DESC LIMIT 1").get(recipeId) as RunRow | undefined;
  return r ? toRun(r) : null;
}

/** Lists without the (possibly large) result payload. */
export function listRuns(opts: { limit?: number; before?: string; recipeId?: string; status?: string; q?: string } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.before) { where.push("created_at < ?"); args.push(opts.before); }
  if (opts.recipeId) { where.push("recipe_id = ?"); args.push(opts.recipeId); }
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.q) { where.push("(url LIKE ? OR recipe_id IN (SELECT id FROM recipes WHERE name LIKE ?))"); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  const limit = pageSize(opts.limit);
  const rows = db().prepare(
    `SELECT id, recipe_id, job_id, url, final_url, mode, status, extract, NULL AS result, row_count, page_count, error, duration_ms, created_at,
       version, diagnosis, score, validation,
       (SELECT name FROM recipes WHERE recipes.id = scrape_runs.recipe_id) AS recipe_name
     FROM scrape_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
  ).all(...args, limit + 1) as RunRow[];
  const items = rows.slice(0, limit).map(toRun);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

/** Rows per run for a task's trend chart. */
export function runTrend(recipeId: string, limit = 30) {
  return (db().prepare("SELECT created_at, row_count, status, duration_ms FROM scrape_runs WHERE recipe_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(recipeId, limit) as { created_at: string; row_count: number; status: RunStatus; duration_ms: number }[]).reverse();
}

export function deleteRun(id: string) {
  if (privateRuns.delete(id)) return true;
  return db().prepare("DELETE FROM scrape_runs WHERE id = ?").run(id).changes > 0;
}

export function deleteRuns(ids: string[]) {
  ids = ids.filter((id) => !privateRuns.delete(id));
  const stmt = db().prepare("DELETE FROM scrape_runs WHERE id = ?");
  return db().transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))();
}

export function pruneRuns(keep = 500) {
  return db().prepare(
    "DELETE FROM scrape_runs WHERE id NOT IN (SELECT id FROM scrape_runs ORDER BY created_at DESC LIMIT ?)",
  ).run(keep).changes;
}

/** Incremental scraping: which of these keys (normalized URLs) an earlier run of the task already saw. */
export function seenKeys(recipeId: string, keys: string[]): Set<string> {
  if (!keys.length) return new Set();
  const out = new Set<string>();
  const stmt = db().prepare("SELECT 1 FROM task_seen WHERE recipe_id = ? AND key = ?");
  for (const k of keys) if (stmt.get(recipeId, k)) out.add(k);
  return out;
}

export function markSeen(recipeId: string, keys: string[]) {
  const stmt = db().prepare("INSERT OR IGNORE INTO task_seen (recipe_id, key, first_seen) VALUES (?, ?, ?)");
  const t = now();
  db().transaction(() => { for (const k of keys) stmt.run(recipeId, k, t); })();
}

export function forgetSeen(recipeId: string) {
  return db().prepare("DELETE FROM task_seen WHERE recipe_id = ?").run(recipeId).changes;
}

export function seenCount(recipeId: string) {
  return (db().prepare("SELECT COUNT(*) c FROM task_seen WHERE recipe_id = ?").get(recipeId) as { c: number }).c;
}
