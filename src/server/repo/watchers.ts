import "server-only";
import { db } from "../db";
import type { Condition, FetchMode, NotifyChannels, WatcherInput, WatchTarget } from "@/lib/schemas";
import { newId, now, pageSize, parseJson } from "./util";

type WatcherRow = {
  id: string; name: string; url: string; mode: FetchMode; target: string; condition: string; notify: string; ignore_lines: string;
  interval_minutes: number; enabled: number; last_checked_at: string | null; next_check_at: string | null;
  last_status: string | null; last_error: string | null; last_value: number | null; fail_count: number;
  check_count: number; change_count: number; created_at: string; updated_at: string;
};

export type Watcher = Omit<WatcherRow, "target" | "condition" | "notify" | "enabled" | "ignore_lines"> & {
  target: WatchTarget; condition: Condition; notify: NotifyChannels; enabled: boolean; ignore_lines: string[];
};

const toWatcher = (r: WatcherRow): Watcher => ({
  ...r,
  target: parseJson<WatchTarget>(r.target, { type: "page" }),
  condition: parseJson<Condition>(r.condition, { type: "any_change" }),
  notify: parseJson<NotifyChannels>(r.notify, { desktop: true, webhook: false, telegram: false }),
  enabled: Boolean(r.enabled),
  ignore_lines: parseJson<string[]>(r.ignore_lines, []),
});

export function listWatchers(): Watcher[] {
  return (db().prepare("SELECT * FROM watchers ORDER BY created_at DESC LIMIT 500").all() as WatcherRow[]).map(toWatcher);
}

export function getWatcher(id: string): Watcher | null {
  const r = db().prepare("SELECT * FROM watchers WHERE id = ?").get(id) as WatcherRow | undefined;
  return r ? toWatcher(r) : null;
}

export function createWatcher(input: WatcherInput): Watcher {
  const id = newId();
  const t = now();
  db().prepare(
    `INSERT INTO watchers (id, name, url, mode, target, condition, notify, ignore_lines, interval_minutes, enabled, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.url, input.mode, JSON.stringify(input.target), JSON.stringify(input.condition),
    JSON.stringify(input.notify), JSON.stringify(input.ignoreLines), input.intervalMinutes, input.enabled ? 1 : 0, t, t, t);
  return getWatcher(id)!;
}

export function updateWatcher(id: string, input: WatcherInput): Watcher | null {
  const before = getWatcher(id);
  if (!before) return null;
  // A changed target makes the old baseline meaningless, so reset it.
  const targetChanged = JSON.stringify(before.target) !== JSON.stringify(input.target) || before.url !== input.url ||
    JSON.stringify(before.ignore_lines) !== JSON.stringify(input.ignoreLines);
  db().transaction(() => {
    db().prepare(
      `UPDATE watchers SET name = ?, url = ?, mode = ?, target = ?, condition = ?, notify = ?, ignore_lines = ?, interval_minutes = ?, enabled = ?,
       next_check_at = CASE WHEN ? = 1 AND enabled = 0 THEN ? ELSE next_check_at END, updated_at = ? WHERE id = ?`,
    ).run(input.name, input.url, input.mode, JSON.stringify(input.target), JSON.stringify(input.condition),
      JSON.stringify(input.notify), JSON.stringify(input.ignoreLines), input.intervalMinutes, input.enabled ? 1 : 0, input.enabled ? 1 : 0, now(), now(), id);
    if (targetChanged) {
      db().prepare("DELETE FROM snapshots WHERE watcher_id = ?").run(id);
      db().prepare("UPDATE watchers SET last_value = NULL, next_check_at = ? WHERE id = ?").run(now(), id);
    }
  })();
  return getWatcher(id);
}

export function setWatcherEnabled(id: string, enabled: boolean) {
  return db().prepare("UPDATE watchers SET enabled = ?, next_check_at = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, now(), now(), id).changes > 0;
}

export function deleteWatcher(id: string) {
  return db().prepare("DELETE FROM watchers WHERE id = ?").run(id).changes > 0;
}

/** Atomically claims due watchers by pushing their next check forward, so a slow run is never picked twice. */
export function claimDueWatchers(limit: number): Watcher[] {
  const t = now();
  return db().transaction(() => {
    const rows = db().prepare(
      "SELECT * FROM watchers WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT ?",
    ).all(t, limit) as WatcherRow[];
    const lease = new Date(Date.now() + 10 * 60_000).toISOString();
    const stmt = db().prepare("UPDATE watchers SET next_check_at = ? WHERE id = ?");
    for (const r of rows) stmt.run(lease, r.id);
    return rows.map(toWatcher);
  })();
}

export function recordCheck(id: string, outcome: {
  status: "ok" | "error" | "blocked"; error?: string | null; value?: number | null; changed: boolean; nextCheckAt: string;
}) {
  db().prepare(
    `UPDATE watchers SET last_checked_at = ?, next_check_at = ?, last_status = ?, last_error = ?,
       last_value = COALESCE(?, last_value),
       fail_count = CASE WHEN ? = 'ok' THEN 0 ELSE fail_count + 1 END,
       check_count = check_count + 1, change_count = change_count + ?, updated_at = ?
     WHERE id = ?`,
  ).run(now(), outcome.nextCheckAt, outcome.status, outcome.error ?? null, outcome.value ?? null, outcome.status,
    outcome.changed ? 1 : 0, now(), id);
}

type SnapshotRow = {
  id: string; watcher_id: string; content: string; content_hash: string; value: number | null;
  changed: number; triggered: number; diff: string | null; created_at: string;
};
export type DiffSummary = { added: number; removed: number; patch: { op: "+" | "-" | " "; text: string }[] };
export type Snapshot = Omit<SnapshotRow, "diff" | "changed" | "triggered"> & {
  diff: DiffSummary | null; changed: boolean; triggered: boolean;
};

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  ...r, diff: parseJson<DiffSummary | null>(r.diff, null), changed: Boolean(r.changed), triggered: Boolean(r.triggered),
});

export function latestSnapshot(watcherId: string): Snapshot | null {
  const r = db().prepare("SELECT * FROM snapshots WHERE watcher_id = ? ORDER BY created_at DESC LIMIT 1").get(watcherId) as SnapshotRow | undefined;
  return r ? toSnapshot(r) : null;
}

export function addSnapshot(input: {
  watcherId: string; content: string; hash: string; value: number | null; changed: boolean; triggered: boolean; diff: DiffSummary | null;
}) {
  const id = newId();
  db().prepare(
    "INSERT INTO snapshots (id, watcher_id, content, content_hash, value, changed, triggered, diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.watcherId, input.content, input.hash, input.value, input.changed ? 1 : 0, input.triggered ? 1 : 0,
    input.diff ? JSON.stringify(input.diff) : null, now());
  return id;
}

/** Unchanged checks only bump the latest snapshot's time instead of storing duplicates. */
export function touchSnapshot(id: string) {
  db().prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run(now(), id);
}

export function listSnapshots(watcherId: string, opts: { limit?: number; before?: string; changedOnly?: boolean } = {}) {
  const limit = pageSize(opts.limit, 100, 30);
  const rows = db().prepare(
    `SELECT id, watcher_id, '' AS content, content_hash, value, changed, triggered, diff, created_at FROM snapshots
     WHERE watcher_id = ? ${opts.before ? "AND created_at < ?" : ""} ${opts.changedOnly ? "AND changed = 1" : ""}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(watcherId, ...(opts.before ? [opts.before] : []), limit + 1) as SnapshotRow[];
  const items = rows.slice(0, limit).map(toSnapshot);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function getSnapshot(watcherId: string, id: string): Snapshot | null {
  const r = db().prepare("SELECT * FROM snapshots WHERE id = ? AND watcher_id = ?").get(id, watcherId) as SnapshotRow | undefined;
  return r ? toSnapshot(r) : null;
}

export function valueSeries(watcherId: string, limit = 200) {
  return (db().prepare(
    "SELECT value, created_at FROM snapshots WHERE watcher_id = ? AND value IS NOT NULL ORDER BY created_at DESC LIMIT ?",
  ).all(watcherId, limit) as { value: number; created_at: string }[]).reverse();
}

/** Keeps the newest N snapshots per watcher. */
export function pruneSnapshots(keepPerWatcher = 200) {
  return db().prepare(
    `DELETE FROM snapshots WHERE id IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY watcher_id ORDER BY created_at DESC) rn FROM snapshots) WHERE rn > ?)`,
  ).run(keepPerWatcher).changes;
}
