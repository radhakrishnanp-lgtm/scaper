import { z } from "zod";
import { handler, idParam, notFound } from "@/server/api";
import { getRun, listRuns } from "@/server/repo/scrapes";
import { mainDatasetIndex } from "@/server/tasks/engine";
import type { Cell } from "@/lib/types";

export const dynamic = "force-dynamic";

const query = z.object({ with: z.string().max(60).optional(), key: z.string().max(400).optional() });

/**
 * Row-level diff between two runs of the same data: added, removed and changed rows (same key, different
 * values, with the columns that changed). Without `with`, compares against the previous run of the same task.
 */
export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const cur = getRun(id);
  if (!cur?.result) throw notFound("Run with data");
  let other = q.with ? getRun(q.with) : null;
  if (!other && cur.recipe_id) {
    const older = listRuns({ recipeId: cur.recipe_id, before: cur.created_at, limit: 5 }).items.find((r) => r.row_count > 0);
    other = older ? getRun(older.id) : null;
  }
  const choices = cur.recipe_id ? listRuns({ recipeId: cur.recipe_id, limit: 30 }).items.filter((r) => r.id !== id && r.row_count > 0).map((r) => ({ id: r.id, created_at: r.created_at, rows: r.row_count })) : [];
  if (!other?.result) return { base: null, choices, added: [], removed: [], changed: [], columns: [], key: [] };

  const a = other.result.datasets[mainDatasetIndex(other.result.datasets)]!;
  const b = cur.result.datasets[mainDatasetIndex(cur.result.datasets)]!;
  const columns = [...new Set([...b.columns, ...a.columns])].filter((c) => !c.endsWith("_value"));
  const wanted = q.key ? q.key.split(",").map((s) => s.trim()).filter((k) => columns.includes(k)) : [];
  // Default key: a link column if there is one, otherwise all columns (so "changed" stays empty).
  const key = wanted.length ? wanted : columns.filter((c) => /^(link|url|href|product_url)$/i.test(c)).slice(0, 1);
  const keyOf = (r: Record<string, Cell>) => JSON.stringify((key.length ? key : columns).map((k) => r[k] ?? null));
  const older = new Map(a.rows.map((r) => [keyOf(r), r]));
  const newer = new Map(b.rows.map((r) => [keyOf(r), r]));
  const added = b.rows.filter((r) => !older.has(keyOf(r)));
  const removed = a.rows.filter((r) => !newer.has(keyOf(r)));
  const changed: { key: string; before: Record<string, Cell>; after: Record<string, Cell>; columns: string[] }[] = [];
  if (key.length) {
    for (const [k, r] of newer) {
      const o = older.get(k);
      if (!o) continue;
      const diff = columns.filter((c) => !key.includes(c) && c !== "source_url" && String(o[c] ?? "") !== String(r[c] ?? ""));
      if (diff.length) changed.push({ key: k, before: o, after: r, columns: diff });
    }
  }
  return {
    base: { id: other.id, created_at: other.created_at, rows: a.rows.length },
    current: { id: cur.id, created_at: cur.created_at, rows: b.rows.length },
    choices, columns, key,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    added: added.slice(0, 500), removed: removed.slice(0, 500), changed: changed.slice(0, 500),
  };
});
