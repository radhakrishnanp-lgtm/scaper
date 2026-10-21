import "server-only";
import { db } from "../db";
import type { ExtractSpec, FetchMode } from "@/lib/schemas";
import { newId, now, pageSize, parseJson } from "./util";

export type { Dataset, ScrapeResult } from "@/lib/types";
import type { ScrapeResult } from "@/lib/types";

type RecipeRow = {
  id: string; name: string; url: string; mode: FetchMode; extract: string; created_at: string; updated_at: string;
  schedule_minutes: number | null; next_run_at: string | null; last_run_at: string | null; last_status: string | null;
};
type RecipeInput = { name: string; url: string; mode: FetchMode; extract: ExtractSpec; scheduleMinutes?: number | null };
export type Recipe = Omit<RecipeRow, "extract"> & { extract: ExtractSpec };

const toRecipe = (r: RecipeRow): Recipe => ({ ...r, extract: parseJson<ExtractSpec>(r.extract, { type: "auto" }) });

export function listRecipes(): Recipe[] {
  return (db().prepare("SELECT * FROM recipes ORDER BY updated_at DESC LIMIT 200").all() as RecipeRow[]).map(toRecipe);
}

export function getRecipe(id: string): Recipe | null {
  const r = db().prepare("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | undefined;
  return r ? toRecipe(r) : null;
}

const firstRun = (minutes: number | null | undefined) => (minutes ? new Date(Date.now() + 60_000).toISOString() : null);

export function createRecipe(input: RecipeInput): Recipe {
  const id = newId();
  const t = now();
  db().prepare(
    "INSERT INTO recipes (id, name, url, mode, extract, schedule_minutes, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.name, input.url, input.mode, JSON.stringify(input.extract), input.scheduleMinutes ?? null, firstRun(input.scheduleMinutes), t, t);
  return getRecipe(id)!;
}

export function updateRecipe(id: string, input: RecipeInput) {
  const before = getRecipe(id);
  if (!before) return null;
  const schedule = input.scheduleMinutes ?? null;
  // Keep the existing slot unless the schedule itself changed.
  const next = schedule === before.schedule_minutes ? before.next_run_at : firstRun(schedule);
  db().prepare("UPDATE recipes SET name = ?, url = ?, mode = ?, extract = ?, schedule_minutes = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(input.name, input.url, input.mode, JSON.stringify(input.extract), schedule, next, now(), id);
  return getRecipe(id);
}

/** Scheduler: claims recipes whose run is due by pushing their slot forward. */
export function claimDueRecipes(limit: number): Recipe[] {
  const t = now();
  return db().transaction(() => {
    const rows = db().prepare(
      "SELECT * FROM recipes WHERE schedule_minutes IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
    ).all(t, limit) as RecipeRow[];
    const stmt = db().prepare("UPDATE recipes SET next_run_at = ? WHERE id = ?");
    for (const r of rows) stmt.run(new Date(Date.now() + r.schedule_minutes! * 60_000).toISOString(), r.id);
    return rows.map(toRecipe);
  })();
}

export function recordRecipeRun(id: string, status: string) {
  db().prepare("UPDATE recipes SET last_run_at = ?, last_status = ? WHERE id = ?").run(now(), status, id);
}

export function deleteRecipe(id: string) {
  return db().prepare("DELETE FROM recipes WHERE id = ?").run(id).changes > 0;
}

type RunRow = {
  id: string; recipe_id: string | null; url: string; final_url: string | null; mode: FetchMode;
  status: "ok" | "error" | "blocked"; extract: string; result: string | null; row_count: number;
  error: string | null; duration_ms: number; created_at: string;
};
export type ScrapeRun = Omit<RunRow, "extract" | "result"> & { extract: ExtractSpec; result: ScrapeResult | null };

const toRun = (r: RunRow): ScrapeRun => ({
  ...r,
  extract: parseJson<ExtractSpec>(r.extract, { type: "auto" }),
  result: parseJson<ScrapeResult | null>(r.result, null),
});

export function saveRun(input: Omit<ScrapeRun, "id" | "created_at">): ScrapeRun {
  const id = newId();
  db().prepare(
    `INSERT INTO scrape_runs (id, recipe_id, url, final_url, mode, status, extract, result, row_count, error, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.recipe_id, input.url, input.final_url, input.mode, input.status, JSON.stringify(input.extract),
    input.result ? JSON.stringify(input.result) : null, input.row_count, input.error, input.duration_ms, now(),
  );
  return getRun(id)!;
}

export function getRun(id: string): ScrapeRun | null {
  const r = db().prepare("SELECT * FROM scrape_runs WHERE id = ?").get(id) as RunRow | undefined;
  return r ? toRun(r) : null;
}

/** Lists without the (possibly large) result payload. */
export function listRuns(opts: { limit?: number; before?: string; recipeId?: string } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.before) { where.push("created_at < ?"); args.push(opts.before); }
  if (opts.recipeId) { where.push("recipe_id = ?"); args.push(opts.recipeId); }
  const limit = pageSize(opts.limit);
  const rows = db().prepare(
    `SELECT id, recipe_id, url, final_url, mode, status, extract, NULL AS result, row_count, error, duration_ms, created_at
     FROM scrape_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
  ).all(...args, limit + 1) as RunRow[];
  const items = rows.slice(0, limit).map(toRun);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function deleteRun(id: string) {
  return db().prepare("DELETE FROM scrape_runs WHERE id = ?").run(id).changes > 0;
}

export function pruneRuns(keep = 500) {
  return db().prepare(
    "DELETE FROM scrape_runs WHERE id NOT IN (SELECT id FROM scrape_runs ORDER BY created_at DESC LIMIT ?)",
  ).run(keep).changes;
}
