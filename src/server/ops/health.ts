import "server-only";
import type { Diagnosis } from "@/lib/types";
import { db } from "../db";
import { pendingProposal, pendingProposalCount } from "../repo/heal";
import { listIssues, openIssueCounts } from "../repo/quality";
import { listRecipes, recentGoodCounts, runHistory, type RunStatus, type RunValidationSummary, type Task } from "../repo/scrapes";
import { changeCounts, listWatchers } from "../repo/watchers";
import { parseJson } from "../repo/util";
import { expectedRange } from "./diagnose";

const OK = new Set<RunStatus>(["ok", "partial"]);
const FAILED = new Set<RunStatus>(["error", "blocked"]);

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

const dayKey = (iso: string) => iso.slice(0, 10);

/** Daily run outcomes for the last N days (oldest first), for the status strip. */
export function dailyStrip(runs: { created_at: string; status: RunStatus }[], days = 30) {
  const out: { day: string; ok: number; failed: number; other: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000).toISOString().slice(0, 10);
    out.push({ day: d, ok: 0, failed: 0, other: 0 });
  }
  const index = new Map(out.map((d, i) => [d.day, i]));
  for (const r of runs) {
    const i = index.get(dayKey(r.created_at));
    if (i === undefined) continue;
    if (OK.has(r.status)) out[i]!.ok++; else if (FAILED.has(r.status)) out[i]!.failed++; else out[i]!.other++;
  }
  return out;
}

/** The Health tab of a task: status strip, last 200 runs, usual range, latency percentiles, issues and repairs. */
export function taskHealth(task: Task) {
  const runs = runHistory(task.id, 200);
  const since30 = Date.now() - 30 * 86400_000;
  const since7 = Date.now() - 7 * 86400_000;
  const in30 = runs.filter((r) => Date.parse(r.created_at) >= since30);
  const in7 = runs.filter((r) => Date.parse(r.created_at) >= since7);
  const rate = (rs: typeof runs) => (rs.length ? Math.round((rs.filter((r) => OK.has(r.status)).length / rs.length) * 1000) / 10 : null);
  const durations = runs.filter((r) => OK.has(r.status)).slice(0, 50).map((r) => r.duration_ms);
  let streak = 0;
  for (const r of runs) { if (FAILED.has(r.status)) streak++; else break; }
  const latestProblem = runs.find((r) => r.diagnosis);
  const good = recentGoodCounts(task.id);
  const range = expectedRange(good);
  return {
    successRate7d: rate(in7), successRate30d: rate(in30), runs30d: in30.length, failStreak: streak,
    p50: percentile(durations, 50), p95: percentile(durations, 95),
    expected: range ? { ...range, runs: good.length } : null,
    unhealthySince: task.health_alerted_at,
    daily: dailyStrip(in30, 30),
    runs: runs.slice().reverse().map((r) => ({
      id: r.id, jobId: r.job_id, at: r.created_at, status: r.status, rows: r.row_count, pages: r.page_count, ms: r.duration_ms, version: r.version, score: r.score,
      diagnosis: parseJson<Diagnosis | null>(r.diagnosis, null), validation: parseJson<RunValidationSummary | null>(r.validation, null),
    })),
    latestDiagnosis: latestProblem && runs[0] === latestProblem ? parseJson<Diagnosis | null>(latestProblem.diagnosis, null) : null,
    issues: listIssues(task.id, undefined, 50),
    pendingRepair: pendingProposal(task.id),
  };
}

/** A stable label for an error message, so the same failure on different pages or days groups together. */
export function errorFingerprint(message: string) {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/"[^"]{1,200}"/g, "\"…\"")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|min|seconds?|minutes?)\b/gi, "<time>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

type TaskRow = { recipe_id: string; status: RunStatus; row_count: number; duration_ms: number; created_at: string; error: string | null; diagnosis: string | null; score: number | null };

/**
 * The Operations page: every task and watcher with its recent outcomes, plus failures grouped by cause
 * across the last 7 days, repairs waiting for review and the change inbox count.
 */
export function fleetHealth() {
  const tasks = listRecipes();
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const rows = db().prepare(
    "SELECT recipe_id, status, row_count, duration_ms, created_at, error, diagnosis, score FROM scrape_runs WHERE recipe_id IS NOT NULL AND created_at >= ? ORDER BY created_at",
  ).all(since30) as TaskRow[];
  const byTask = new Map<string, TaskRow[]>();
  for (const r of rows) { const l = byTask.get(r.recipe_id) ?? []; l.push(r); byTask.set(r.recipe_id, l); }
  const issues = openIssueCounts();
  const taskItems = tasks.map((t) => {
    const rs = byTask.get(t.id) ?? [];
    const last = rs.at(-1);
    const durations = rs.filter((r) => OK.has(r.status)).map((r) => r.duration_ms);
    return {
      id: t.id, name: t.name, url: t.url, tags: t.tags, scheduled: Boolean(t.schedule_minutes || t.cron),
      lastStatus: last?.status ?? t.last_status, lastRunAt: last?.created_at ?? t.last_run_at, lastRows: last?.row_count ?? null, lastScore: last?.score ?? null,
      runs: rs.length, successRate: rs.length ? Math.round((rs.filter((r) => OK.has(r.status)).length / rs.length) * 1000) / 10 : null,
      p95: percentile(durations, 95), strip: rs.slice(-30).map((r) => ({ at: r.created_at, status: r.status, rows: r.row_count })),
      diagnosis: last?.diagnosis ? parseJson<Diagnosis | null>(last.diagnosis, null) : null,
      openIssues: issues[t.id] ?? 0, unhealthy: Boolean(t.health_alerted_at), healMode: t.options.heal.mode,
    };
  });

  const watchers = listWatchers().map((w) => ({
    id: w.id, name: w.name, url: w.url, tags: w.tags, enabled: w.enabled, lastStatus: w.last_status, lastCheckedAt: w.last_checked_at,
    failCount: w.fail_count, lastError: w.last_error, checks: w.check_count, changes: w.change_count, type: w.target.type,
  }));
  const watcherMs = db().prepare(
    "SELECT watcher_id, AVG(response_ms) avg, MAX(response_ms) max FROM snapshots WHERE response_ms IS NOT NULL AND created_at >= ? GROUP BY watcher_id",
  ).all(since7) as { watcher_id: string; avg: number; max: number }[];
  const msBy = new Map(watcherMs.map((m) => [m.watcher_id, m]));

  // Failures grouped by cause (diagnosis code, else fingerprint of the message), tasks and watchers together.
  const groups = new Map<string, { key: string; title: string; area: string; count: number; last: string; items: Map<string, { kind: "task" | "watcher"; id: string; name: string }> }>();
  const add = (key: string, title: string, area: string, at: string, item: { kind: "task" | "watcher"; id: string; name: string }) => {
    const g = groups.get(key) ?? { key, title, area, count: 0, last: at, items: new Map() };
    g.count++;
    if (at > g.last) g.last = at;
    g.items.set(`${item.kind}:${item.id}`, item);
    groups.set(key, g);
  };
  const names = new Map(tasks.map((t) => [t.id, t.name]));
  for (const r of rows) {
    if (r.created_at < since7 || !(FAILED.has(r.status) || r.diagnosis)) continue;
    const d = parseJson<Diagnosis | null>(r.diagnosis, null);
    if (!d && !r.error) continue;
    add(d?.code ?? errorFingerprint(r.error!), d?.title ?? errorFingerprint(r.error!), d?.area ?? "site", r.created_at, { kind: "task", id: r.recipe_id, name: names.get(r.recipe_id) ?? "Task" });
  }
  for (const w of watchers) {
    if (w.failCount > 0 && w.lastError) add(errorFingerprint(w.lastError), w.lastError.split(". ")[0]!.slice(0, 140), "site", w.lastCheckedAt ?? "", { kind: "watcher", id: w.id, name: w.name });
  }
  const errorGroups = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20).map((g) => ({ ...g, items: [...g.items.values()].slice(0, 8), affected: g.items.size }));

  const all30 = rows.length;
  const ok30 = rows.filter((r) => OK.has(r.status)).length;
  return {
    summary: {
      tasks: tasks.length, unhealthyTasks: taskItems.filter((t) => t.unhealthy || (t.lastStatus && FAILED.has(t.lastStatus as RunStatus))).length,
      watchers: watchers.length, failingWatchers: watchers.filter((w) => w.failCount > 0).length,
      successRate30d: all30 ? Math.round((ok30 / all30) * 1000) / 10 : null, runs30d: all30,
      openIssues: Object.values(issues).reduce((s, n) => s + n, 0), pendingRepairs: pendingProposalCount(), changes: changeCounts(),
    },
    daily: dailyStrip(rows, 30),
    tasks: taskItems,
    watchers: watchers.map((w) => ({ ...w, avgMs: msBy.get(w.id)?.avg ? Math.round(msBy.get(w.id)!.avg) : null, maxMs: msBy.get(w.id)?.max ?? null })),
    errorGroups,
  };
}
