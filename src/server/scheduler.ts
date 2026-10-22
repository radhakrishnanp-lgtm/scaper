import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { closeBrowser } from "./fetcher/browser";
import { enqueue, pump } from "./jobs";
import { log } from "./log";
import { configuredChannels, deliver } from "./notify";
import { listBackups } from "./ops/backup";
import { failStaleAgentRuns } from "./repo/agent";
import { claimDueDealSearches } from "./repo/deal-searches";
import { audit, pruneEvents } from "./repo/events";
import { jobCounts, pruneJobs } from "./repo/jobs";
import { pruneNotifications } from "./repo/notifications";
import { claimDueProducts } from "./repo/products";
import { claimDueRecipes, pruneRuns } from "./repo/scrapes";
import { getSettings } from "./repo/settings";
import { pruneHostStats } from "./repo/sites";
import { db } from "./db";
import { changesSince, claimDueWatchers, pruneSnapshots, referencedMedia } from "./repo/watchers";
import { deleteMedia, mediaRoot } from "./watch/visual";

const TICK_MS = 15_000;
const MAINTENANCE_MS = 6 * 60 * 60_000;

type State = { timer: NodeJS.Timeout | null; lastTick: string | null; lastMaintenance: number; started: string | null; lastDigestDay: string | null };
const g = globalThis as unknown as { __scaperScheduler?: State };
const state: State = (g.__scaperScheduler ??= { timer: null, lastTick: null, lastMaintenance: 0, started: null, lastDigestDay: null });

/** Removes media files no snapshot points at any more (after pruning or deleting watchers). */
async function cleanOrphanMedia() {
  const keep = referencedMedia();
  const root = path.join(mediaRoot(), "watchers");
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const d of dirs) {
    const files = await fs.readdir(path.join(root, d)).catch(() => [] as string[]);
    for (const f of files) {
      if (!keep.has(`watchers/${d}/${f}`)) { await fs.rm(path.join(root, d, f), { force: true }); removed++; }
    }
    if (!(await fs.readdir(path.join(root, d)).catch(() => ["x"])).length) await fs.rmdir(path.join(root, d)).catch(() => undefined);
  }
  return removed;
}

async function maintenance() {
  state.lastMaintenance = Date.now();
  const d = getSettings().data;
  const snaps = pruneSnapshots(d.keepSnapshots);
  await deleteMedia(snaps.media);
  const removed = {
    events: pruneEvents(d.keepEventsDays), notifications: pruneNotifications(90), runs: pruneRuns(d.keepRuns),
    snapshots: snaps.removed, jobs: pruneJobs(d.keepJobsDays), hostStats: pruneHostStats(90), orphanMedia: await cleanOrphanMedia(),
  };
  db().pragma("wal_checkpoint(TRUNCATE)");
  log.info("maintenance.done", removed);
  if (d.autoBackup) {
    const latest = (await listBackups())[0];
    if (!latest || Date.now() - Date.parse(latest.created_at) > 23 * 60 * 60_000) {
      enqueue({ kind: "backup", title: "Daily backup", trigger: "schedule", refId: "backup", unique: true });
    }
  }
}

/** Once a day at the chosen hour: one message listing every watcher change of the last 24 hours. */
async function maybeDigest() {
  const n = getSettings().notifications;
  if (n.digest !== "daily") return;
  const nowD = new Date();
  const day = nowD.toISOString().slice(0, 10);
  if (state.lastDigestDay === day || nowD.getHours() !== n.digestHour) return;
  state.lastDigestDay = day;
  const already = db().prepare("SELECT 1 FROM event_log WHERE event = 'digest.sent' AND created_at >= ?").get(`${day}T00:00:00`);
  if (already) return;
  const changes = changesSince(new Date(Date.now() - 86400_000).toISOString());
  const byWatcher = new Map<string, { name: string; url: string; count: number }>();
  for (const c of changes) {
    const e = byWatcher.get(c.watcher_id) ?? { name: c.name, url: c.url, count: 0 };
    e.count++;
    byWatcher.set(c.watcher_id, e);
  }
  const lines = [...byWatcher.values()].sort((a, b) => b.count - a.count).map((e) => `• ${e.name}: ${e.count} change${e.count === 1 ? "" : "s"}`);
  const body = lines.length ? lines.slice(0, 40).join("\n") : "No watcher saw a change in the last 24 hours.";
  await deliver({ kind: "system", title: `Daily digest: ${changes.length} change${changes.length === 1 ? "" : "s"} on ${byWatcher.size} watcher${byWatcher.size === 1 ? "" : "s"}`, body }, { ...configuredChannels(), desktop: false });
  audit("digest.sent", { changes: changes.length });
}

async function tick() {
  state.lastTick = new Date().toISOString();
  try {
    if (Date.now() - state.lastMaintenance > MAINTENANCE_MS) await maintenance();
    await maybeDigest();
    // Keep the queue short: only claim new work when the backlog is small.
    const s = getSettings().scraping;
    const counts = jobCounts();
    const room = s.jobConcurrency * 3 - counts.queued;
    if (room > 0) {
      const watchers = claimDueWatchers(room);
      for (const w of watchers) enqueue({ kind: "watch", refId: w.id, title: `Check: ${w.name}`, trigger: "schedule", input: { watcherId: w.id }, unique: true });
      const products = claimDueProducts(room - watchers.length);
      for (const p of products) enqueue({ kind: "product", refId: p.id, title: `Price: ${p.title?.slice(0, 80) ?? p.url}`, trigger: "schedule", input: { productId: p.id }, unique: true });
      const tasks = claimDueRecipes(room - watchers.length - products.length);
      for (const r of tasks) enqueue({ kind: "task", refId: r.id, title: `Task: ${r.name}`, trigger: "schedule", input: { taskId: r.id }, maxAttempts: r.options.retries + 1, unique: true });
      const searches = claimDueDealSearches(room - watchers.length - products.length - tasks.length);
      for (const d of searches) enqueue({ kind: "deal_search", refId: d.id, title: `Deals: ${d.name}`, trigger: "schedule", input: { dealSearchId: d.id }, unique: true });
    }
    pump();
  } catch (e) {
    log.error("scheduler.tick_failed", { error: e as Error });
  }
}

/** Starts the in-process scheduler once per server process (safe across hot reloads). */
export function startScheduler() {
  if (state.timer) return;
  failStaleAgentRuns();
  state.started = new Date().toISOString();
  state.timer = setInterval(() => void tick(), TICK_MS);
  state.timer.unref?.();
  setTimeout(() => void tick(), 2000).unref?.();
  log.info("scheduler.started", { tickMs: TICK_MS });
  const stop = () => { if (state.timer) clearInterval(state.timer); state.timer = null; void closeBrowser(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export function schedulerStatus() {
  const counts = jobCounts();
  return { running: Boolean(state.timer), activeJobs: counts.running, queuedJobs: counts.queued, lastTick: state.lastTick, startedAt: state.started };
}

/** For tests: run one scheduler tick now. */
export const runTickForTests = tick;
