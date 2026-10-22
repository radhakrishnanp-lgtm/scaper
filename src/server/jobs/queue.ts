import "server-only";
import { bus } from "../bus";
import { log } from "../log";
import {
  activeJobFor, addJobLog, cancelQueuedJob, claimNextJob, createJob, failInterruptedJobs, finishJob, getJob, requeueJob, setJobProgress,
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
};
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

type State = {
  handlers: Map<string, JobHandler>;
  running: Map<string, AbortController>;
  waiters: Map<string, ((j: Job) => void)[]>;
  pumping: boolean;
  recovered: boolean;
};
const g = globalThis as unknown as { __scaperQueue?: State };
const state: State = (g.__scaperQueue ??= { handlers: new Map(), running: new Map(), waiters: new Map(), pumping: false, recovered: false });

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
    if (existing) return existing;
  }
  const job = createJob(input);
  emit(job);
  queueMicrotask(pump);
  return job;
}

/** Enqueue and wait for the result (for "Run now" buttons). Resolves with the job as it stands at the timeout. */
export async function enqueueAndWait(input: EnqueueInput, timeoutMs = 120_000): Promise<Job> {
  const job = enqueue({ priority: 10, ...input });
  return waitForJob(job.id, timeoutMs);
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
  };
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
    const final = getJob(job.id);
    if (final) {
      emit(final);
      if (!["queued", "running"].includes(final.status)) settle(final);
    }
    queueMicrotask(pump);
  }
}
