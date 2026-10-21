import "server-only";
import { db } from "../db";
import type { ExtractSpec, FetchMode } from "@/lib/schemas";
import { newId, now, pageSize, parseJson } from "./util";

export type { Dataset, ScrapeResult } from "@/lib/types";
import type { ScrapeResult } from "@/lib/types";

type RecipeRow = { id: string; name: string; url: string; mode: FetchMode; extract: string; created_at: string; updated_at: string };
export type Recipe = Omit<RecipeRow, "extract"> & { extract: ExtractSpec };

const toRecipe = (r: RecipeRow): Recipe => ({ ...r, extract: parseJson<ExtractSpec>(r.extract, { type: "auto" }) });

export function listRecipes(): Recipe[] {
  return (db().prepare("SELECT * FROM recipes ORDER BY updated_at DESC LIMIT 200").all() as RecipeRow[]).map(toRecipe);
}

export function getRecipe(id: string): Recipe | null {
  const r = db().prepare("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | undefined;
  return r ? toRecipe(r) : null;
}

export function createRecipe(input: { name: string; url: string; mode: FetchMode; extract: ExtractSpec }): Recipe {
  const id = newId();
  const t = now();
  db().prepare("INSERT INTO recipes (id, name, url, mode, extract, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.name, input.url, input.mode, JSON.stringify(input.extract), t, t);
  return getRecipe(id)!;
}

export function updateRecipe(id: string, input: { name: string; url: string; mode: FetchMode; extract: ExtractSpec }) {
  const res = db().prepare("UPDATE recipes SET name = ?, url = ?, mode = ?, extract = ?, updated_at = ? WHERE id = ?")
    .run(input.name, input.url, input.mode, JSON.stringify(input.extract), now(), id);
  return res.changes ? getRecipe(id) : null;
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
