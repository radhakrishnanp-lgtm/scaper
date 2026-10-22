import { Cron } from "croner";
import type { WatcherOptions } from "@/lib/schemas";

type Window = WatcherOptions["activeHours"];

const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h! * 60 + m!; };

/** True when `at` (local time) falls inside the active days and hours. Overnight windows (22:00–06:00) work too. */
export function inWindow(at: Date, w: Window): boolean {
  if (!w.enabled) return true;
  const mins = at.getHours() * 60 + at.getMinutes();
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  const day = at.getDay();
  if (start <= end) return w.days.includes(day) && mins >= start && mins < end;
  // Overnight: the part after midnight belongs to the previous day's window.
  if (mins >= start) return w.days.includes(day);
  return mins < end && w.days.includes((day + 6) % 7);
}

/** Moves a time forward to the next moment inside the window (or returns it unchanged). */
export function nextInWindow(at: Date, w: Window): Date {
  if (!w.enabled || !w.days.length || inWindow(at, w)) return at;
  const start = minutesOf(w.start);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(at);
    d.setDate(d.getDate() + i);
    d.setHours(Math.floor(start / 60), start % 60, 0, 0);
    if (d > at && inWindow(d, w)) return d;
  }
  return at;
}

/**
 * When to check next: a cron schedule or the interval (with 10% jitter so checks
 * don't line up), backed off exponentially after failures, then moved into active hours.
 */
export function nextCheckTime(intervalMinutes: number, options: Pick<WatcherOptions, "cron" | "activeHours">, failures: number, from = new Date()): Date {
  const base = intervalMinutes * 60_000;
  const backoff = failures > 0 ? Math.min(base * 2 ** Math.min(failures, 5), Math.max(base, 6 * 60 * 60_000)) : 0;
  let next: Date;
  if (options.cron) {
    let cronNext: Date | null = null;
    try { cronNext = new Cron(options.cron, { paused: true }).nextRun(from); } catch { cronNext = null; }
    next = cronNext ?? new Date(from.getTime() + base);
    if (backoff && next.getTime() < from.getTime() + backoff) next = new Date(from.getTime() + backoff);
  } else {
    const wait = backoff || base;
    next = new Date(from.getTime() + wait + wait * 0.1 * Math.random());
  }
  return nextInWindow(next, options.activeHours);
}

/** The next few run times of a cron expression, for the "next runs" preview. */
export function previewCron(expr: string, count = 5, from = new Date()): string[] {
  const job = new Cron(expr, { paused: true });
  return job.nextRuns(count, from).map((d) => d.toISOString());
}
