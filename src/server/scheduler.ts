import "server-only";
import { refreshProduct } from "./deals/tracker";
import { closeBrowser } from "./fetcher/browser";
import { log } from "./log";
import { failStaleAgentRuns } from "./repo/agent";
import { pruneEvents } from "./repo/events";
import { pruneNotifications } from "./repo/notifications";
import { claimDueProducts } from "./repo/products";
import { claimDueRecipes, pruneRuns } from "./repo/scrapes";
import { runScheduledRecipe } from "./recipes/scheduled";
import { getSettings } from "./repo/settings";
import { claimDueWatchers, pruneSnapshots } from "./repo/watchers";
import { checkWatcher } from "./watch/runner";

const TICK_MS = 15_000;
const MAINTENANCE_MS = 6 * 60 * 60_000;

type State = { timer: NodeJS.Timeout | null; running: number; lastTick: string | null; lastMaintenance: number; started: string | null };
const g = globalThis as unknown as { __scaperScheduler?: State };
const state: State = (g.__scaperScheduler ??= { timer: null, running: 0, lastTick: null, lastMaintenance: 0, started: null });

function maintenance() {
  const removed = { events: pruneEvents(30), notifications: pruneNotifications(90), runs: pruneRuns(500), snapshots: pruneSnapshots(200) };
  log.info("maintenance.done", removed);
  state.lastMaintenance = Date.now();
}

async function tick() {
  state.lastTick = new Date().toISOString();
  try {
    if (Date.now() - state.lastMaintenance > MAINTENANCE_MS) maintenance();
    const capacity = getSettings().scraping.maxConcurrency * 2 - state.running;
    if (capacity <= 0) return;
    const watchers = claimDueWatchers(capacity);
    const products = claimDueProducts(Math.max(0, capacity - watchers.length));
    const recipes = claimDueRecipes(Math.max(0, capacity - watchers.length - products.length));
    for (const r of recipes) {
      state.running++;
      void runScheduledRecipe(r).catch((e: Error) => log.error("recipe.run_failed", { recipeId: r.id, error: e })).finally(() => state.running--);
    }
    for (const w of watchers) {
      state.running++;
      void checkWatcher(w).finally(() => state.running--);
    }
    for (const p of products) {
      state.running++;
      void refreshProduct(p).finally(() => state.running--);
    }
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
  return { running: Boolean(state.timer), activeJobs: state.running, lastTick: state.lastTick, startedAt: state.started };
}
