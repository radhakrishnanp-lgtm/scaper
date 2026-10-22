import "server-only";
import { db } from "../db";
import {
  defaultWatcherOptions, notifySchema, watcherOptionsSchema,
  type Condition, type FetchMode, type NotifyChannels, type WatcherInput, type WatcherOptions, type WatchTarget,
} from "@/lib/schemas";
import { newId, now, pageSize, parseJson } from "./util";
import { deleteVersions, ensureBaseline, recordVersion, type VersionSource } from "./versions";

type WatcherRow = {
  id: string; name: string; url: string; mode: FetchMode; target: string; condition: string; notify: string; ignore_lines: string;
  options: string; tags: string; interval_minutes: number; enabled: number; last_checked_at: string | null; next_check_at: string | null;
  last_status: string | null; last_error: string | null; last_value: number | null; fail_count: number;
  check_count: number; change_count: number; last_notified_at: string | null; last_change_at: string | null; error_alerted_at: string | null;
  created_at: string; updated_at: string; version: number;
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
  recordVersion("watcher", id, { ...watcherVersionData(getWatcher(id)!), enabled: true }, "create");
  return getWatcher(id)!;
}

/** What a watcher version stores: everything you can edit, in the shape the watcher API accepts. */
export function watcherVersionData(w: Watcher): WatcherInput {
  return { name: w.name, url: w.url, mode: w.mode, target: w.target, condition: w.condition, notify: w.notify, intervalMinutes: w.interval_minutes, enabled: w.enabled, ignoreLines: w.ignore_lines, options: w.options, tags: w.tags };
}

/** What makes the old baseline meaningless when it changes. */
const baselineKey = (w: { url: string; target: unknown; ignore: unknown; opts: WatcherOptions }) =>
  JSON.stringify([w.url, w.target, w.ignore, w.opts.onlyMatching, w.opts.ignoreRegex, w.opts.ignoreNumbers, w.opts.ignoreCase, w.opts.steps]);

export function updateWatcher(id: string, input: WatcherInput, change: { source?: VersionSource; note?: string; keepHistory?: boolean } = {}): Watcher | null {
  const before = getWatcher(id);
  if (!before) return null;
  ensureBaseline("watcher", id, () => ({ ...watcherVersionData(before), enabled: true }));
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
    if (targetChanged && !change.keepHistory) {
      db().prepare("DELETE FROM snapshots WHERE watcher_id = ?").run(id);
      db().prepare("UPDATE watchers SET last_value = NULL, next_check_at = ? WHERE id = ?").run(now(), id);
    }
  })();
  // "enabled" is a switch, not setup, so pausing doesn't create a version.
  const after = getWatcher(id)!;
  recordVersion("watcher", id, { ...watcherVersionData(after), enabled: true }, change.source ?? "edit", change.note);
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
  deleteVersions("watcher", id);
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
  important: number | null; summary: string | null; reviewed_at: string | null; feedback: string | null;
};
export type DiffSummary = { added: number; removed: number; patch: { op: "+" | "-" | " "; text: string }[] };
export type Feedback = "useful" | "not_useful";
export type Snapshot = Omit<SnapshotRow, "diff" | "changed" | "triggered" | "verdict" | "important" | "feedback"> & {
  diff: DiffSummary | null; changed: boolean; triggered: boolean; verdict: Verdict | null; important: boolean | null; feedback: Feedback | null;
};

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  ...r, diff: parseJson<DiffSummary | null>(r.diff, null), changed: Boolean(r.changed), triggered: Boolean(r.triggered),
  verdict: parseJson<Verdict | null>(r.verdict, null), important: r.important === null || r.important === undefined ? null : Boolean(r.important),
  feedback: (r.feedback as Feedback | null) ?? null,
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
  important?: boolean | null; summary?: string | null;
}) {
  const id = input.id ?? newId();
  db().prepare(
    `INSERT INTO snapshots (id, watcher_id, content, content_hash, value, changed, triggered, diff, screenshot, visual_diff, visual_change, verdict, status_code, response_ms, created_at, important, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.watcherId, input.content, input.hash, input.value, input.changed ? 1 : 0, input.triggered ? 1 : 0,
    input.diff ? JSON.stringify(input.diff) : null, input.screenshot ?? null, input.visualDiff ?? null, input.visualChange ?? null,
    input.verdict ? JSON.stringify(input.verdict) : null, input.statusCode ?? null, input.responseMs ?? null, now(),
    input.important === null || input.important === undefined ? null : input.important ? 1 : 0, input.summary ?? null);
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
    `SELECT id, watcher_id, '' AS content, content_hash, value, changed, triggered, diff, screenshot, visual_diff, visual_change, verdict, status_code, response_ms, created_at,
       important, summary, reviewed_at, feedback
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

export type ChangeFilter = { status?: "all" | "unreviewed" | "important" | "not_useful"; watcherId?: string; tag?: string; q?: string; before?: string; limit?: number; since?: string };
export type ChangeItem = Snapshot & { watcher_name: string; watcher_url: string; watcher_tags: string[]; target_type: string };

/** The change inbox: every detected change across watchers, newest first, with its triage state. */
export function listChanges(f: ChangeFilter = {}) {
  const where = ["s.changed = 1"];
  const args: unknown[] = [];
  if (f.status === "unreviewed") where.push("s.reviewed_at IS NULL");
  if (f.status === "important") where.push("s.important = 1");
  if (f.status === "not_useful") where.push("s.feedback = 'not_useful'");
  if (f.watcherId) { where.push("s.watcher_id = ?"); args.push(f.watcherId); }
  if (f.before) { where.push("s.created_at < ?"); args.push(f.before); }
  if (f.since) { where.push("s.created_at >= ?"); args.push(f.since); }
  if (f.q) { where.push("(w.name LIKE ? OR s.summary LIKE ? OR s.diff LIKE ?)"); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const limit = pageSize(f.limit, 200, 40);
  let rows = db().prepare(
    `SELECT s.id, s.watcher_id, '' AS content, s.content_hash, s.value, s.changed, s.triggered, s.diff, s.screenshot, s.visual_diff, s.visual_change, s.verdict,
       s.status_code, s.response_ms, s.created_at, s.important, s.summary, s.reviewed_at, s.feedback,
       w.name AS watcher_name, w.url AS watcher_url, w.tags AS watcher_tags, w.target AS watcher_target
     FROM snapshots s JOIN watchers w ON w.id = s.watcher_id WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC LIMIT ?`,
  ).all(...args, f.tag ? 2000 : limit + 1) as (SnapshotRow & { watcher_name: string; watcher_url: string; watcher_tags: string; watcher_target: string })[];
  if (f.tag) rows = rows.filter((r) => parseJson<string[]>(r.watcher_tags, []).includes(f.tag!)).slice(0, limit + 1);
  const items: ChangeItem[] = rows.slice(0, limit).map((r) => ({
    ...toSnapshot(r), watcher_name: r.watcher_name, watcher_url: r.watcher_url, watcher_tags: parseJson<string[]>(r.watcher_tags, []),
    target_type: parseJson<{ type: string }>(r.watcher_target, { type: "page" }).type,
  }));
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function changeCounts() {
  const r = db().prepare(
    `SELECT COUNT(*) total, SUM(reviewed_at IS NULL) unreviewed, SUM(important = 1) important, SUM(important = 1 AND reviewed_at IS NULL) important_unreviewed
     FROM snapshots WHERE changed = 1 AND created_at >= ?`,
  ).get(new Date(Date.now() - 90 * 86400_000).toISOString()) as { total: number; unreviewed: number | null; important: number | null; important_unreviewed: number | null };
  return { total: r.total, unreviewed: r.unreviewed ?? 0, important: r.important ?? 0, importantUnreviewed: r.important_unreviewed ?? 0 };
}

/** Mark changes reviewed (or not), important (or not), and record your feedback. */
export function triageChanges(ids: string[], patch: { reviewed?: boolean; important?: boolean | null; feedback?: Feedback | null }) {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.reviewed !== undefined) { sets.push("reviewed_at = ?"); args.push(patch.reviewed ? now() : null); }
  if (patch.important !== undefined) { sets.push("important = ?"); args.push(patch.important === null ? null : patch.important ? 1 : 0); }
  if (patch.feedback !== undefined) { sets.push("feedback = ?"); args.push(patch.feedback); }
  if (!sets.length || !ids.length) return 0;
  const stmt = db().prepare(`UPDATE snapshots SET ${sets.join(", ")} WHERE id = ? AND changed = 1`);
  return db().transaction(() => ids.reduce((n, id) => n + stmt.run(...args, id).changes, 0))();
}

/** "Mark all reviewed", optionally for one watcher. */
export function reviewAll(watcherId?: string) {
  return db().prepare(`UPDATE snapshots SET reviewed_at = ? WHERE changed = 1 AND reviewed_at IS NULL ${watcherId ? "AND watcher_id = ?" : ""}`)
    .run(now(), ...(watcherId ? [watcherId] : [])).changes;
}

/** Recent changes you marked "not useful", so the AI can learn what you don't care about. */
export function notUsefulExamples(watcherId: string, limit = 6): string[] {
  const rows = db().prepare("SELECT summary, diff FROM snapshots WHERE watcher_id = ? AND feedback = 'not_useful' ORDER BY created_at DESC LIMIT ?").all(watcherId, limit) as { summary: string | null; diff: string | null }[];
  return rows.map((r) => r.summary || (parseJson<DiffSummary | null>(r.diff, null)?.patch.filter((p) => p.op !== " ").slice(0, 3).map((p) => `${p.op} ${p.text}`).join(" / ") ?? "")).filter(Boolean).map((s) => s.slice(0, 200));
}

/** Adds phrases to a watcher's ignore list (from "not useful" feedback), keeping its history. */
export function addIgnoreLines(id: string, lines: string[]) {
  const w = getWatcher(id);
  if (!w) return null;
  const next = [...new Set([...w.ignore_lines, ...lines.map((l) => l.trim()).filter(Boolean)])].slice(0, 30);
  return updateWatcher(id, { ...watcherVersionData(w), ignoreLines: next }, { source: "edit", note: "Ignored lines added from your feedback", keepHistory: true });
}

/** Replaces the latest snapshot's stored text and hash (after new noise filters), so the next check compares like with like. */
export function rebaseLatest(watcherId: string, content: string, hash: string) {
  const latest = latestSnapshot(watcherId);
  if (!latest) return false;
  return db().prepare("UPDATE snapshots SET content = ?, content_hash = ? WHERE id = ?").run(content, hash, latest.id).changes > 0;
}
