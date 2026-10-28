import "server-only";
import { bus } from "../bus";
import { log } from "../log";
import {
  activeJobFor, addJobLog, cancelQueuedJob, claimNextJob, createJob, failInterruptedJobs, finishJob, getCheckpoint, getJob, markJobPaused, markJobResumed,
  pausedJobIds, requeueJob, saveCheckpoint, setJobProgress,
  type Job, type JobKind, type JobLog, type JobProgress, type JobTrigger,
} from "../repo/jobs";
import { getSettings } from "../repo/settings";
import { withWork } from "../privacy";

/**
 * Durable job queue on SQLite. Every piece of background work (task runs, watcher
 * checks, price refreshes, deal searches, backups) is a row in `jobs`, so it shows
 * up in the Runs page with progress and logs, can be cancelled, and survives a
 * restart as a clear "interrupted" record instead of vanishing.
 */

export class JobCancelled extends Error {
  constructor() { super("Cancelled."); }
}

/** Thrown by a handler that stopped at a safe point because you paused it; its checkpoint is already saved. */
export class JobPaused extends Error {
  constructor() { super("Paused."); }
}

/** Job kinds that can stop at a safe point and carry on later. */
export const PAUSABLE_KINDS: JobKind[] = ["task", "scrape"];

/** A failure that should be recorded with what was done so far. `noRetry` for refusals (bot checks, robots.txt) that a retry would only repeat. */
export function jobFailure(message: string, partialResult: Record<string, unknown> | null, noRetry = false) {
  return Object.assign(new Error(message), { partialResult, noRetry });
}

export type JobContext = {
  job: Job;
  signal: AbortSignal;
  log: (level: JobLog["level"], message: string, data?: Record<string, unknown>) => void;
  progress: (p: JobProgress) => void;
  throwIfCancelled: () => void;
  /** True once you pressed Pause: stop at the next safe point, save a checkpoint and throw JobPaused. */
  pauseRequested: () => boolean;
  /** Saves where the work is, so a pause or a restart can carry on from there. */
  checkpoint: (state: unknown) => void;
  /** The checkpoint this run resumes from, if any. */
  resumeFrom: unknown;
};
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

type State = {
  handlers: Map<string, JobHandler>;
  running: Map<string, AbortController>;
  pausing: Set<string>;
  waiters: Map<string, ((j: Job) => void)[]>;
  pumping: boolean;
  recovered: boolean;
};
const g = globalThis as unknown as { __scaperQueue?: State };
const state: State = (g.__scaperQueue ??= { handlers: new Map(), running: new Map(), pausing: new Set(), waiters: new Map(), pumping: false, recovered: false });

export function registerJobHandler(kind: JobKind, handler: JobHandler) {
  state.handlers.set(kind, handler);
}

function emit(j: Job) {
  bus.emit({ type: "job", id: j.id, status: j.status, kind: j.kind, title: j.title, progress: j.progress as Record<string, unknown> });
}

export type EnqueueInput = {
  kind: JobKind; refId?: string | null; title: string; trigger?: JobTrigger; input?: Record<string, unknown>;
  priority?: number; maxAttempts?: number; runAfter?: string;
  /** Keep the job, its logs and its result in memory only. */
  private?: boolean;
  /** Return the existing queued/running job for the same ref instead of adding another. */
  unique?: boolean;
};

export function enqueue(input: EnqueueInput): Job {
  if (input.unique && input.refId) {
    const existing = activeJobFor(input.kind, input.refId);
    // A paused run of the same thing is not started twice: the schedule waits for it, Run now resumes it.
    if (existing?.status === "paused" && input.trigger !== "schedule") resumeJob(existing.id);
    if (existing) return getJob(existing.id) ?? existing;
  }
  const job = createJob(input);
  emit(job);
  queueMicrotask(pump);
  return job;
}

/** Enqueue and wait for the result (for "Run now" buttons). Resolves with the job as it stands at the timeout. */
/** Runs a job and waits for it. When `signal` aborts (the AI was stopped), the job is cancelled too. */
export async function enqueueAndWait(input: EnqueueInput, timeoutMs = 120_000, signal?: AbortSignal): Promise<Job> {
  if (signal?.aborted) throw new Error("Stopped by you.");
  const job = enqueue({ priority: 10, ...input });
  const stop = () => { cancelJob(job.id); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const done = await waitForJob(job.id, timeoutMs);
    if (signal?.aborted) throw new Error("Stopped by you.");
    return done;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

export function waitForJob(id: string, timeoutMs: number): Promise<Job> {
  const current = getJob(id);
  if (!current || !["queued", "running"].includes(current.status)) return Promise.resolve(current!);
  return new Promise((resolve) => {
    const done = (j: Job) => { clearTimeout(timer); resolve(j); };
    const timer = setTimeout(() => {
      const list = state.waiters.get(id) ?? [];
      state.waiters.set(id, list.filter((w) => w !== done));
      resolve(getJob(id)!);
    }, timeoutMs);
    state.waiters.set(id, [...(state.waiters.get(id) ?? []), done]);
  });
}

export function cancelJob(id: string) {
  if (cancelQueuedJob(id)) {
    const j = getJob(id)!;
    emit(j);
    settle(j);
    return true;
  }
  const ctrl = state.running.get(id);
  if (ctrl) { ctrl.abort(); return true; }
  return false;
}

/**
 * Pause: a queued job just waits; a running task run stops after the page it is on, keeping its rows,
 * and carries on from there when resumed. Other kinds of work are short and cannot pause.
 */
export function pauseJob(id: string): { ok: boolean; message: string } {
  const j = getJob(id);
  if (!j) return { ok: false, message: "That run no longer exists." };
  if (j.private) return { ok: false, message: "Private runs cannot pause; cancel it instead." };
  if (j.status === "queued") {
    markJobPaused(id, "Paused before it started.");
    emit(getJob(id)!);
    return { ok: true, message: "Paused. It starts when you resume it." };
  }
  if (j.status !== "running") return { ok: false, message: `It is ${j.status}, so there is nothing to pause.` };
  if (!PAUSABLE_KINDS.includes(j.kind)) return { ok: false, message: "Only task runs can pause. This one is short; cancel it instead." };
  state.pausing.add(id);
  return { ok: true, message: "Pausing after the current page." };
}

export function resumeJob(id: string): { ok: boolean; message: string } {
  const j = getJob(id);
  if (!j) return { ok: false, message: "That run no longer exists." };
  if (j.status !== "paused") return { ok: false, message: `It is ${j.status}, not paused.` };
  markJobResumed(id);
  const fresh = getJob(id)!;
  emit(fresh);
  queueMicrotask(pump);
  return { ok: true, message: j.resumable ? "Resumed. It carries on where it stopped." : "Resumed." };
}

/** Pause every queued and running task run (and anything else still queued). Returns how many were paused. */
export function pauseAllJobs(listActive: () => Job[]) {
  let n = 0;
  for (const j of listActive()) {
    if (j.status === "queued" || (j.status === "running" && PAUSABLE_KINDS.includes(j.kind))) { if (pauseJob(j.id).ok) n++; }
  }
  return n;
}

export function resumeAllJobs() {
  let n = 0;
  for (const id of pausedJobIds()) if (resumeJob(id).ok) n++;
  return n;
}

export function runningJobCount() {
  return state.running.size;
}

function settle(j: Job) {
  const list = state.waiters.get(j.id);
  state.waiters.delete(j.id);
  list?.forEach((fn) => fn(j));
}

/** On first use after a (re)start, close out jobs that were running when the process stopped. */
export function recoverJobs() {
  if (state.recovered) return;
  state.recovered = true;
  const n = failInterruptedJobs();
  if (n) log.warn("jobs.interrupted", { count: n });
}

/** Starts as many queued jobs as the concurrency setting allows. */
export function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    recoverJobs();
    const limit = getSettings().scraping.jobConcurrency;
    while (state.running.size < limit) {
      const job = claimNextJob();
      if (!job) break;
      void execute(job);
    }
  } catch (e) {
    log.error("jobs.pump_failed", { error: e as Error });
  } finally {
    state.pumping = false;
  }
}

async function execute(job: Job) {
  const ctrl = new AbortController();
  state.running.set(job.id, ctrl);
  emit(job);
  let lastEmit = 0;
  const ctx: JobContext = {
    job,
    signal: ctrl.signal,
    log: (level, message, data) => {
      try { addJobLog(job.id, level, message, data); } catch { /* job deleted mid-run */ }
    },
    progress: (p) => {
      job.progress = { ...job.progress, ...p };
      setJobProgress(job.id, job.progress);
      if (Date.now() - lastEmit > 500) { lastEmit = Date.now(); emit(job); }
    },
    throwIfCancelled: () => { if (ctrl.signal.aborted) throw new JobCancelled(); },
    pauseRequested: () => state.pausing.has(job.id),
    checkpoint: (cp) => { try { saveCheckpoint(job.id, cp); } catch { /* job deleted mid-run */ } },
    resumeFrom: job.private ? null : getCheckpoint(job.id),
  };
  if (ctx.resumeFrom) ctx.log("info", "Carrying on from where the run stopped.");
  const handler = state.handlers.get(job.kind);
  try {
    if (!handler) throw new Error(`No handler for job kind "${job.kind}".`);
    const result = await withWork({ private: job.private, refId: job.id }, () => handler(ctx));
    if (ctrl.signal.aborted) {
      // Work done before the cancel (rows scraped so far) is kept with the cancelled job.
      ctx.log("warn", "Cancelled.");
      finishJob(job.id, "cancelled", (result as Record<string, unknown>) ?? null, "Cancelled.");
    } else {
      finishJob(job.id, "succeeded", (result as Record<string, unknown>) ?? null, null);
    }
  } catch (e) {
    if (e instanceof JobPaused) {
      ctx.log("info", "Paused. Resume to carry on from here.");
      markJobPaused(job.id, "Paused by you.");
      return;
    }
    const cancelled = e instanceof JobCancelled || ctrl.signal.aborted;
    const message = cancelled ? "Cancelled." : (e as Error).message || "Job failed.";
    const partial = (e as { partialResult?: Record<string, unknown> }).partialResult ?? null;
    const noRetry = Boolean((e as { noRetry?: boolean }).noRetry);
    if (!cancelled && !noRetry && job.attempts < job.max_attempts) {
      const delay = Math.min(30 * 60_000, 30_000 * 2 ** (job.attempts - 1));
      ctx.log("warn", `Attempt ${job.attempts} failed: ${message}. Retrying in ${Math.round(delay / 1000)}s.`);
      requeueJob(job.id, new Date(Date.now() + delay).toISOString(), message);
    } else {
      ctx.log(cancelled ? "warn" : "error", message);
      finishJob(job.id, cancelled ? "cancelled" : "failed", partial, message);
    }
  } finally {
    state.running.delete(job.id);
    state.pausing.delete(job.id);
    const final = getJob(job.id);
    if (final) {
      emit(final);
      if (["succeeded", "failed", "cancelled"].includes(final.status) && !final.private) saveCheckpoint(job.id, null);
      if (!["queued", "running"].includes(final.status)) settle(final);
    }
    queueMicrotask(pump);
  }
}
