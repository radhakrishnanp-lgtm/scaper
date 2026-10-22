import "server-only";
import { db } from "../db";
import {
  defaultWatcherOptions, notifySchema, watcherOptionsSchema,
  type Condition, type FetchMode, type NotifyChannels, type WatcherInput, type WatcherOptions, type WatchTarget,
} from "@/lib/schemas";
import { newId, now, pageSize, parseJson } from "./util";

type WatcherRow = {
  id: string; name: string; url: string; mode: FetchMode; target: string; condition: string; notify: string; ignore_lines: string;
  options: string; tags: string; interval_minutes: number; enabled: number; last_checked_at: string | null; next_check_at: string | null;
  last_status: string | null; last_error: string | null; last_value: number | null; fail_count: number;
  check_count: number; change_count: number; last_notified_at: string | null; last_change_at: string | null; error_alerted_at: string | null;
  created_at: string; updated_at: string;
};

export type Watcher = Omit<WatcherRow, "target" | "condition" | "notify" | "enabled" | "ignore_lines" | "options" | "tags"> & {
  target: WatchTarget; condition: Condition; notify: NotifyChannels; enabled: boolean; ignore_lines: string[]; options: WatcherOptions; tags: string[];
};

const toWatcher = (r: WatcherRow): Watcher => {
  const opts = watcherOptionsSchema.safeParse(parseJson(r.options, {}));
  return {
    ...r,
    target: parseJson<WatchTarget>(r.target, { type: "page" }),
    condition: parseJson<Condition>(r.condition, { type: "any_change" }),
    notify: notifySchema.parse(parseJson(r.notify, {})),
    enabled: Boolean(r.enabled),
    ignore_lines: parseJson<string[]>(r.ignore_lines, []),
    options: opts.success ? opts.data : defaultWatcherOptions(),
    tags: parseJson<string[]>(r.tags, []),
  };
};

export type WatcherFilter = { q?: string; tag?: string; status?: "active" | "paused" | "errors" | "changed" };

export function listWatchers(filter: WatcherFilter = {}): Watcher[] {
  let rows = (db().prepare("SELECT * FROM watchers ORDER BY created_at DESC LIMIT 2000").all() as WatcherRow[]).map(toWatcher);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((w) => w.name.toLowerCase().includes(q) || w.url.toLowerCase().includes(q));
  }
  if (filter.tag) rows = rows.filter((w) => w.tags.includes(filter.tag!));
  if (filter.status === "active") rows = rows.filter((w) => w.enabled);
  if (filter.status === "paused") rows = rows.filter((w) => !w.enabled);
  if (filter.status === "errors") rows = rows.filter((w) => w.fail_count > 0);
  if (filter.status === "changed") rows = rows.filter((w) => w.last_change_at && Date.now() - Date.parse(w.last_change_at) < 7 * 86400_000);
  return rows;
}

export function allWatcherTags(): string[] {
  const rows = db().prepare("SELECT tags FROM watchers").all() as { tags: string }[];
  return [...new Set(rows.flatMap((r) => parseJson<string[]>(r.tags, [])))].sort();
}

export function getWatcher(id: string): Watcher | null {
  const r = db().prepare("SELECT * FROM watchers WHERE id = ?").get(id) as WatcherRow | undefined;
  return r ? toWatcher(r) : null;
}

export function createWatcher(input: WatcherInput): Watcher {
  const id = newId();
  const t = now();
  db().prepare(
    `INSERT INTO watchers (id, name, url, mode, target, condition, notify, ignore_lines, options, tags, interval_minutes, enabled, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.url, input.mode, JSON.stringify(input.target), JSON.stringify(input.condition),
    JSON.stringify(input.notify), JSON.stringify(input.ignoreLines), JSON.stringify(input.options ?? defaultWatcherOptions()),
    JSON.stringify(input.tags ?? []), input.intervalMinutes, input.enabled ? 1 : 0, t, t, t);
  return getWatcher(id)!;
}

/** What makes the old baseline meaningless when it changes. */
const baselineKey = (w: { url: string; target: unknown; ignore: unknown; opts: WatcherOptions }) =>
  JSON.stringify([w.url, w.target, w.ignore, w.opts.onlyMatching, w.opts.ignoreRegex, w.opts.ignoreNumbers, w.opts.ignoreCase, w.opts.steps]);

export function updateWatcher(id: string, input: WatcherInput): Watcher | null {
  const before = getWatcher(id);
  if (!before) return null;
  const opts = input.options ?? before.options;
  const targetChanged = baselineKey({ url: before.url, target: before.target, ignore: before.ignore_lines, opts: before.options }) !==
    baselineKey({ url: input.url, target: input.target, ignore: input.ignoreLines, opts });
  db().transaction(() => {
    db().prepare(
      `UPDATE watchers SET name = ?, url = ?, mode = ?, target = ?, condition = ?, notify = ?, ignore_lines = ?, options = ?, tags = ?, interval_minutes = ?, enabled = ?,
       next_check_at = CASE WHEN ? = 1 AND enabled = 0 THEN ? ELSE next_check_at END, updated_at = ? WHERE id = ?`,
    ).run(input.name, input.url, input.mode, JSON.stringify(input.target), JSON.stringify(input.condition),
      JSON.stringify(input.notify), JSON.stringify(input.ignoreLines), JSON.stringify(opts), JSON.stringify(input.tags ?? before.tags),
      input.intervalMinutes, input.enabled ? 1 : 0, input.enabled ? 1 : 0, now(), now(), id);
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

export function setWatcherTags(id: string, tags: string[]) {
  return db().prepare("UPDATE watchers SET tags = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...new Set(tags)].slice(0, 12)), now(), id).changes > 0;
}

/** "Clear error flag": forget past failures so the watcher looks healthy until the next check. */
export function clearWatcherError(id: string) {
  return db().prepare("UPDATE watchers SET fail_count = 0, last_error = NULL, error_alerted_at = NULL, last_status = CASE WHEN last_status = 'ok' THEN 'ok' ELSE NULL END WHERE id = ?").run(id).changes > 0;
}

export function deleteWatcher(id: string) {
  return db().prepare("DELETE FROM watchers WHERE id = ?").run(id).changes > 0;
}

/** Atomically claims due watchers by pushing their next check forward, so a slow run is never picked twice. */
export function claimDueWatchers(limit: number): Watcher[] {
  if (limit <= 0) return [];
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
  status: "ok" | "error" | "blocked"; error?: string | null; value?: number | null; changed: boolean; notified?: boolean; nextCheckAt: string;
}) {
  const t = now();
  db().prepare(
    `UPDATE watchers SET last_checked_at = ?, next_check_at = ?, last_status = ?, last_error = ?,
       last_value = COALESCE(?, last_value),
       fail_count = CASE WHEN ? = 'ok' THEN 0 ELSE fail_count + 1 END,
       error_alerted_at = CASE WHEN ? = 'ok' THEN NULL ELSE error_alerted_at END,
       check_count = check_count + 1, change_count = change_count + ?,
       last_change_at = CASE WHEN ? = 1 THEN ? ELSE last_change_at END,
       last_notified_at = CASE WHEN ? = 1 THEN ? ELSE last_notified_at END,
       updated_at = ?
     WHERE id = ?`,
  ).run(t, outcome.nextCheckAt, outcome.status, outcome.error ?? null, outcome.value ?? null, outcome.status, outcome.status,
    outcome.changed ? 1 : 0, outcome.changed ? 1 : 0, t, outcome.notified ? 1 : 0, t, t, id);
}

export function markErrorAlerted(id: string) {
  db().prepare("UPDATE watchers SET error_alerted_at = ? WHERE id = ?").run(now(), id);
}

export type ConditionResult = { type: string; met: boolean; reason: string };
export type Verdict = { met: boolean; notified: boolean; reason: string; results: ConditionResult[]; suppressed?: string };

type SnapshotRow = {
  id: string; watcher_id: string; content: string; content_hash: string; value: number | null;
  changed: number; triggered: number; diff: string | null; screenshot: string | null; visual_diff: string | null;
  visual_change: number | null; verdict: string | null; status_code: number | null; response_ms: number | null; created_at: string;
};
export type DiffSummary = { added: number; removed: number; patch: { op: "+" | "-" | " "; text: string }[] };
export type Snapshot = Omit<SnapshotRow, "diff" | "changed" | "triggered" | "verdict"> & {
  diff: DiffSummary | null; changed: boolean; triggered: boolean; verdict: Verdict | null;
};

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  ...r, diff: parseJson<DiffSummary | null>(r.diff, null), changed: Boolean(r.changed), triggered: Boolean(r.triggered),
  verdict: parseJson<Verdict | null>(r.verdict, null),
});

export function latestSnapshot(watcherId: string): Snapshot | null {
  const r = db().prepare("SELECT * FROM snapshots WHERE watcher_id = ? ORDER BY created_at DESC LIMIT 1").get(watcherId) as SnapshotRow | undefined;
  return r ? toSnapshot(r) : null;
}

/** The newest snapshot that has a screenshot, as the baseline for visual comparison. */
export function latestScreenshot(watcherId: string): string | null {
  const r = db().prepare("SELECT screenshot FROM snapshots WHERE watcher_id = ? AND screenshot IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(watcherId) as { screenshot: string } | undefined;
  return r?.screenshot ?? null;
}

export function addSnapshot(input: {
  id?: string; watcherId: string; content: string; hash: string; value: number | null; changed: boolean; triggered: boolean; diff: DiffSummary | null;
  screenshot?: string | null; visualDiff?: string | null; visualChange?: number | null; verdict?: Verdict | null; statusCode?: number | null; responseMs?: number | null;
}) {
  const id = input.id ?? newId();
  db().prepare(
    `INSERT INTO snapshots (id, watcher_id, content, content_hash, value, changed, triggered, diff, screenshot, visual_diff, visual_change, verdict, status_code, response_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.watcherId, input.content, input.hash, input.value, input.changed ? 1 : 0, input.triggered ? 1 : 0,
    input.diff ? JSON.stringify(input.diff) : null, input.screenshot ?? null, input.visualDiff ?? null, input.visualChange ?? null,
    input.verdict ? JSON.stringify(input.verdict) : null, input.statusCode ?? null, input.responseMs ?? null, now());
  return id;
}

/** Unchanged checks only bump the latest snapshot's time instead of storing duplicates. */
export function touchSnapshot(id: string, extra: { statusCode?: number | null; responseMs?: number | null; value?: number | null } = {}) {
  db().prepare("UPDATE snapshots SET created_at = ?, status_code = COALESCE(?, status_code), response_ms = COALESCE(?, response_ms) WHERE id = ?")
    .run(now(), extra.statusCode ?? null, extra.responseMs ?? null, id);
}

export function listSnapshots(watcherId: string, opts: { limit?: number; before?: string; changedOnly?: boolean } = {}) {
  const limit = pageSize(opts.limit, 200, 30);
  const rows = db().prepare(
    `SELECT id, watcher_id, '' AS content, content_hash, value, changed, triggered, diff, screenshot, visual_diff, visual_change, verdict, status_code, response_ms, created_at
     FROM snapshots WHERE watcher_id = ? ${opts.before ? "AND created_at < ?" : ""} ${opts.changedOnly ? "AND changed = 1" : ""}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(watcherId, ...(opts.before ? [opts.before] : []), limit + 1) as SnapshotRow[];
  const items = rows.slice(0, limit).map(toSnapshot);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function getSnapshot(watcherId: string, id: string): Snapshot | null {
  const r = db().prepare("SELECT * FROM snapshots WHERE id = ? AND watcher_id = ?").get(id, watcherId) as SnapshotRow | undefined;
  return r ? toSnapshot(r) : null;
}

/** The snapshot just before this one, for "compare with previous". */
export function previousSnapshot(watcherId: string, createdAt: string): Snapshot | null {
  const r = db().prepare("SELECT * FROM snapshots WHERE watcher_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1").get(watcherId, createdAt) as SnapshotRow | undefined;
  return r ? toSnapshot(r) : null;
}

export function valueSeries(watcherId: string, limit = 500) {
  return (db().prepare(
    "SELECT value, created_at FROM snapshots WHERE watcher_id = ? AND value IS NOT NULL ORDER BY created_at DESC LIMIT ?",
  ).all(watcherId, limit) as { value: number; created_at: string }[]).reverse();
}

/** Keeps the newest N snapshots per watcher; returns the media files of the removed ones so they can be deleted. */
export function pruneSnapshots(keepPerWatcher = 200) {
  return db().transaction(() => {
    const doomed = db().prepare(
      `SELECT id, screenshot, visual_diff FROM (SELECT id, screenshot, visual_diff, ROW_NUMBER() OVER (PARTITION BY watcher_id ORDER BY created_at DESC) rn FROM snapshots) WHERE rn > ?`,
    ).all(keepPerWatcher) as { id: string; screenshot: string | null; visual_diff: string | null }[];
    const del = db().prepare("DELETE FROM snapshots WHERE id = ?");
    for (const d of doomed) del.run(d.id);
    return { removed: doomed.length, media: doomed.flatMap((d) => [d.screenshot, d.visual_diff]).filter((m): m is string => Boolean(m)) };
  })();
}

/** All media still referenced, so orphaned files can be cleaned up. */
export function referencedMedia(): Set<string> {
  const rows = db().prepare("SELECT screenshot, visual_diff FROM snapshots WHERE screenshot IS NOT NULL OR visual_diff IS NOT NULL").all() as { screenshot: string | null; visual_diff: string | null }[];
  return new Set(rows.flatMap((r) => [r.screenshot, r.visual_diff]).filter((m): m is string => Boolean(m)));
}

/** Changes across all watchers since a time, for the daily digest. */
export function changesSince(since: string) {
  return db().prepare(
    `SELECT s.watcher_id, w.name, w.url, s.diff, s.created_at FROM snapshots s JOIN watchers w ON w.id = s.watcher_id
     WHERE s.changed = 1 AND s.created_at >= ? ORDER BY s.created_at DESC LIMIT 200`,
  ).all(since) as { watcher_id: string; name: string; url: string; diff: string | null; created_at: string }[];
}
