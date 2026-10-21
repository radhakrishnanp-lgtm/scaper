import { z } from "zod";
import { handler, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { deleteWatcher, getWatcher, setWatcherEnabled, updateWatcher, valueSeries } from "@/server/repo/watchers";
import { watcherSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const watcher = getWatcher(id);
  if (!watcher) throw notFound("Watcher");
  return { watcher, series: valueSeries(id) };
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
