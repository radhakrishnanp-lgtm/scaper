import "server-only";
import { db } from "../db";
import { ephemeral } from "./ephemeral";
import { newId, now, pageSize, parseJson } from "./util";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobKind = "task" | "scrape" | "watch" | "product" | "deal_search" | "backup" | "bulk_products" | "heal" | "sheets";
export type JobTrigger = "manual" | "schedule" | "api" | "agent" | "retry" | "auto" | "repair" | "mcp";
export type JobProgress = { done?: number; total?: number; rows?: number; label?: string };

type JobRow = {
  id: string; kind: JobKind; ref_id: string | null; title: string; status: JobStatus; trigger: JobTrigger;
  input: string; progress: string; result: string | null; error: string | null; attempts: number; max_attempts: number;
  priority: number; run_after: string; created_at: string; started_at: string | null; finished_at: string | null;
};
export type Job = Omit<JobRow, "input" | "progress" | "result"> & {
  input: Record<string, unknown>; progress: JobProgress; result: Record<string, unknown> | null; duration_ms: number | null;
  /** Private jobs live in memory only and vanish an hour after they finish. */
  private?: boolean;
};

// Private jobs: same lifecycle as database jobs, kept in memory.
type MemJob = { row: JobRow; logs: JobLog[] };
const mem = ephemeral<MemJob>("jobs", 60 * 60_000, 100);
let memLogId = 1_000_000_000;
const memJob = (m: MemJob): Job => ({ ...toJob(m.row), private: true });
const touch = (m: MemJob) => mem.set(m.row.id, m);
export type JobLog = { id: number; job_id: string; level: "info" | "warn" | "error"; message: string; data: Record<string, unknown> | null; created_at: string };

const toJob = (r: JobRow): Job => ({
  ...r,
  input: parseJson(r.input, {}),
  progress: parseJson(r.progress, {}),
  result: parseJson(r.result, null),
  duration_ms: r.started_at ? Date.parse(r.finished_at ?? now()) - Date.parse(r.started_at) : null,
});

export function createJob(input: {
  kind: JobKind; refId?: string | null; title: string; trigger?: JobTrigger; input?: Record<string, unknown>;
  priority?: number; maxAttempts?: number; runAfter?: string; private?: boolean;
}): Job {
  const id = newId();
  const t = now();
  if (input.private) {
    const row: JobRow = {
      id, kind: input.kind, ref_id: input.refId ?? null, title: input.title.slice(0, 200), status: "queued", trigger: input.trigger ?? "manual",
      input: JSON.stringify(input.input ?? {}), progress: "{}", result: null, error: null, attempts: 0, max_attempts: input.maxAttempts ?? 1,
      priority: input.priority ?? 0, run_after: input.runAfter ?? t, created_at: t, started_at: null, finished_at: null,
    };
    return memJob(touch({ row, logs: [] }));
  }
  db().prepare(
    `INSERT INTO jobs (id, kind, ref_id, title, status, trigger, input, progress, attempts, max_attempts, priority, run_after, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, '{}', 0, ?, ?, ?, ?)`,
  ).run(id, input.kind, input.refId ?? null, input.title.slice(0, 200), input.trigger ?? "manual", JSON.stringify(input.input ?? {}),
    input.maxAttempts ?? 1, input.priority ?? 0, input.runAfter ?? t, t);
  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  const m = mem.get(id);
  if (m) return memJob(m);
  const r = db().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return r ? toJob(r) : null;
}

/** A queued or running job for the same thing, so schedules never stack duplicate work. */
export function activeJobFor(kind: JobKind, refId: string): Job | null {
  const r = db().prepare("SELECT * FROM jobs WHERE kind = ? AND ref_id = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1").get(kind, refId) as JobRow | undefined;
  return r ? toJob(r) : null;
}

/** Atomically moves the next due job to running. */
export function claimNextJob(): Job | null {
  const t = now();
  const next = mem.values().filter((m) => m.row.status === "queued" && m.row.run_after <= t).sort((a, b) => b.row.priority - a.row.priority || a.row.created_at.localeCompare(b.row.created_at))[0];
  if (next) {
    Object.assign(next.row, { status: "running", attempts: next.row.attempts + 1, started_at: t, finished_at: null });
    return memJob(touch(next));
  }
  return db().transaction(() => {
    const r = db().prepare(
      "SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY priority DESC, run_after, created_at LIMIT 1",
    ).get(t) as JobRow | undefined;
    if (!r) return null;
    db().prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, finished_at = NULL WHERE id = ?").run(t, r.id);
    return getJob(r.id);
  })();
}

export function setJobProgress(id: string, progress: JobProgress) {
  const m = mem.get(id);
  if (m) { m.row.progress = JSON.stringify(progress); touch(m); return; }
  db().prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(JSON.stringify(progress), id);
}

export function finishJob(id: string, status: Exclude<JobStatus, "queued" | "running">, result: Record<string, unknown> | null, error: string | null) {
  const m = mem.get(id);
  if (m) { Object.assign(m.row, { status, result: result ? JSON.stringify(result) : null, error, finished_at: now() }); touch(m); return; }
  db().prepare("UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?")
    .run(status, result ? JSON.stringify(result) : null, error, now(), id);
}

export function requeueJob(id: string, runAfter: string, error: string) {
  const m = mem.get(id);
  if (m) { Object.assign(m.row, { status: "queued", run_after: runAfter, error, started_at: null }); touch(m); return; }
  db().prepare("UPDATE jobs SET status = 'queued', run_after = ?, error = ?, started_at = NULL WHERE id = ?").run(runAfter, error, id);
}

export function cancelQueuedJob(id: string) {
  const m = mem.get(id);
  if (m) {
    if (m.row.status !== "queued") return false;
    Object.assign(m.row, { status: "cancelled", finished_at: now(), error: "Cancelled before it started." });
    touch(m);
    return true;
  }
  return db().prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Cancelled before it started.' WHERE id = ? AND status = 'queued'").run(now(), id).changes > 0;
}

/** After a restart nothing is running any more: mark what was cut off. */
export function failInterruptedJobs() {
  return db().prepare("UPDATE jobs SET status = 'failed', error = 'Interrupted because Scaper restarted.', finished_at = ? WHERE status = 'running'").run(now()).changes;
}

export function addJobLog(jobId: string, level: JobLog["level"], message: string, data?: Record<string, unknown>) {
  const m = mem.get(jobId);
  if (m) { m.logs.push({ id: memLogId++, job_id: jobId, level, message: message.slice(0, 2000), data: data ?? null, created_at: now() }); touch(m); return; }
  db().prepare("INSERT INTO job_logs (job_id, level, message, data, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(jobId, level, message.slice(0, 2000), data ? JSON.stringify(data) : null, now());
}

export function jobLogs(jobId: string, afterId = 0, limit = 500): JobLog[] {
  const m = mem.get(jobId);
  if (m) return m.logs.filter((l) => l.id > afterId).slice(0, limit);
  return (db().prepare("SELECT * FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?").all(jobId, afterId, limit) as (Omit<JobLog, "data"> & { data: string | null })[])
    .map((r) => ({ ...r, data: parseJson(r.data, null) }));
}

export function listJobs(opts: { status?: string; kind?: string; refId?: string; q?: string; limit?: number; before?: string } = {}) {
  const limit = pageSize(opts.limit, 200, 50);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status === "active") where.push("status IN ('queued','running')");
  else if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
  if (opts.refId) { where.push("ref_id = ?"); args.push(opts.refId); }
  if (opts.q) { where.push("title LIKE ?"); args.push(`%${opts.q}%`); }
  if (opts.before) { where.push("created_at < ?"); args.push(opts.before); }
  const rows = db().prepare(`SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit + 1) as JobRow[];
  const items = rows.slice(0, limit).map(toJob);
  // Private jobs show on the first page while they exist, so you can follow and cancel them.
  const priv = opts.before || opts.refId ? [] : mem.values().map(memJob).filter((j) =>
    (!opts.status || (opts.status === "active" ? ["queued", "running"].includes(j.status) : j.status === opts.status))
    && (!opts.kind || j.kind === opts.kind) && (!opts.q || j.title.toLowerCase().includes(opts.q.toLowerCase())));
  return { items: [...priv, ...items], nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function jobCounts() {
  const rows = db().prepare("SELECT status, COUNT(*) c FROM jobs GROUP BY status").all() as { status: JobStatus; c: number }[];
  const out: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

/** Jobs finished per day, for the dashboard chart. */
export function jobsPerDay(days = 14) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return db().prepare(
    `SELECT substr(created_at, 1, 10) day, SUM(status = 'succeeded') ok, SUM(status = 'failed') failed, COUNT(*) total
     FROM jobs WHERE created_at >= ? GROUP BY day ORDER BY day`,
  ).all(since) as { day: string; ok: number; failed: number; total: number }[];
}

export function clearFinishedJobs() {
  return db().prepare("DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled')").run().changes;
}

export function pruneJobs(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db().prepare("DELETE FROM jobs WHERE created_at < ? AND status NOT IN ('queued','running')").run(cutoff).changes;
}
