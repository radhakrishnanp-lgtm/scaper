import "server-only";
import { db } from "../db";
import { dealFiltersSchema, type DealFilters, type DealSearchInput } from "@/lib/schemas";
import { newId, now, parseJson } from "./util";

type Row = {
  id: string; name: string; url: string; filters: string; rank_with_ai: number; schedule_minutes: number | null; notify_new: number;
  next_run_at: string | null; last_run_at: string | null; last_status: string | null; last_count: number | null; last_result: string | null;
  seen: string; created_at: string; updated_at: string;
};
export type DealSearch = Omit<Row, "filters" | "rank_with_ai" | "notify_new" | "last_result" | "seen"> & {
  filters: DealFilters; rank_with_ai: boolean; notify_new: boolean; last_result: Record<string, unknown>[] | null; seen: string[];
};

const MAX_SEEN = 2000;

const toSearch = (r: Row): DealSearch => {
  const f = dealFiltersSchema.safeParse(parseJson(r.filters, {}));
  return {
    ...r, filters: f.success ? f.data : dealFiltersSchema.parse({}), rank_with_ai: Boolean(r.rank_with_ai), notify_new: Boolean(r.notify_new),
    last_result: parseJson(r.last_result, null), seen: parseJson<string[]>(r.seen, []),
  };
};

export function listDealSearches(): DealSearch[] {
  return (db().prepare("SELECT * FROM deal_searches ORDER BY created_at DESC LIMIT 200").all() as Row[]).map(toSearch);
}

export function getDealSearch(id: string): DealSearch | null {
  const r = db().prepare("SELECT * FROM deal_searches WHERE id = ?").get(id) as Row | undefined;
  return r ? toSearch(r) : null;
}

export function createDealSearch(input: DealSearchInput): DealSearch {
  const id = newId();
  const t = now();
  db().prepare(
    `INSERT INTO deal_searches (id, name, url, filters, rank_with_ai, schedule_minutes, notify_new, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.url, JSON.stringify(input.filters), input.rankWithAi ? 1 : 0, input.scheduleMinutes, input.notifyNew ? 1 : 0,
    input.scheduleMinutes ? new Date(Date.now() + 60_000).toISOString() : null, t, t);
  return getDealSearch(id)!;
}

export function updateDealSearch(id: string, input: DealSearchInput) {
  const before = getDealSearch(id);
  if (!before) return null;
  const next = input.scheduleMinutes === before.schedule_minutes ? before.next_run_at : input.scheduleMinutes ? new Date(Date.now() + 60_000).toISOString() : null;
  db().prepare("UPDATE deal_searches SET name = ?, url = ?, filters = ?, rank_with_ai = ?, schedule_minutes = ?, notify_new = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(input.name, input.url, JSON.stringify(input.filters), input.rankWithAi ? 1 : 0, input.scheduleMinutes, input.notifyNew ? 1 : 0, next, now(), id);
  return getDealSearch(id);
}

export function deleteDealSearch(id: string) {
  return db().prepare("DELETE FROM deal_searches WHERE id = ?").run(id).changes > 0;
}

export function claimDueDealSearches(limit: number): DealSearch[] {
  if (limit <= 0) return [];
  const t = now();
  return db().transaction(() => {
    const rows = db().prepare("SELECT * FROM deal_searches WHERE schedule_minutes IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?").all(t, limit) as Row[];
    const stmt = db().prepare("UPDATE deal_searches SET next_run_at = ? WHERE id = ?");
    for (const r of rows) stmt.run(new Date(Date.now() + r.schedule_minutes! * 60_000 * (1 + Math.random() * 0.1)).toISOString(), r.id);
    return rows.map(toSearch);
  })();
}

/** Stores the latest result and remembers which items were already seen (for "new deal" alerts). */
export function recordDealSearchRun(id: string, out: { status: string; items: Record<string, unknown>[]; newKeys: string[] }) {
  const s = getDealSearch(id);
  if (!s) return;
  const seen = [...out.newKeys, ...s.seen].slice(0, MAX_SEEN);
  db().prepare("UPDATE deal_searches SET last_run_at = ?, last_status = ?, last_count = ?, last_result = ?, seen = ? WHERE id = ?")
    .run(now(), out.status, out.items.length, JSON.stringify(out.items.slice(0, 100)), JSON.stringify(seen), id);
}
