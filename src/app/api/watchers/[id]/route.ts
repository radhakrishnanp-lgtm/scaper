import { z } from "zod";
import { handler, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { listJobs } from "@/server/repo/jobs";
import { deleteWatcher, getWatcher, latestSnapshot, setWatcherEnabled, updateWatcher, valueSeries } from "@/server/repo/watchers";
import { previewCron } from "@/server/watch/schedule";
import { watcherSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const watcher = getWatcher(id);
  if (!watcher) throw notFound("Watcher");
  let nextRuns: string[] = [];
  try { if (watcher.options.cron) nextRuns = previewCron(watcher.options.cron, 5); } catch { /* shown as invalid in the form */ }
  const latest = latestSnapshot(id);
  return {
    watcher, series: valueSeries(id), nextRuns, jobs: listJobs({ refId: id, limit: 15 }).items,
    current: latest ? { content: latest.content.slice(0, 20_000), created_at: latest.created_at, value: latest.value, screenshot: latest.screenshot } : null,
  };
});

export const PUT = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const watcher = updateWatcher(id, await readJson(req, watcherSchema));
  if (!watcher) throw notFound("Watcher");
  audit("watcher.updated", { watcherId: id });
  return { watcher };
});

export const PATCH = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const { enabled } = await readJson(req, z.object({ enabled: z.boolean() }));
  if (!setWatcherEnabled(id, enabled)) throw notFound("Watcher");
  audit(enabled ? "watcher.resumed" : "watcher.paused", { watcherId: id });
  return { watcher: getWatcher(id) };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteWatcher(id)) throw notFound("Watcher");
  audit("watcher.deleted", { watcherId: id });
  return { ok: true };
});
