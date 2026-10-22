import { z } from "zod";
import { handler, idParam, notFound } from "@/server/api";
import { audit } from "@/server/repo/events";
import { getWatcher, updateWatcher } from "@/server/repo/watchers";
import { getVersion } from "@/server/repo/versions";
import { watcherSchema } from "@/lib/schemas";

/** Roll back a watcher's setup (its on/off state stays as it is now). */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string; version: string }> }) => {
  const p = await params;
  const id = idParam.parse(p.id);
  const w = getWatcher(id);
  const v = getVersion("watcher", id, z.coerce.number().int().min(1).parse(p.version));
  if (!w || !v) throw notFound("Version");
  const updated = updateWatcher(id, { ...watcherSchema.parse(v.data), enabled: w.enabled }, { source: "restore", note: `Restored version ${v.version}` });
  audit("watcher.restored", { watcherId: id, version: v.version });
  return { watcher: updated };
});
