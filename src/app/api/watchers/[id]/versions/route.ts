import { handler, idParam, notFound } from "@/server/api";
import { getWatcher, watcherVersionData } from "@/server/repo/watchers";
import { ensureBaseline, listVersions } from "@/server/repo/versions";

export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const w = getWatcher(idParam.parse((await params).id));
  if (!w) throw notFound("Watcher");
  ensureBaseline("watcher", w.id, () => ({ ...watcherVersionData(w), enabled: true }));
  return { current: w.version, items: listVersions("watcher", w.id) };
});
