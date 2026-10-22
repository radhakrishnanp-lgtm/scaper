import { handler, idParam, notFound } from "@/server/api";
import { clearWatcherError, getWatcher } from "@/server/repo/watchers";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!clearWatcherError(id)) throw notFound("Watcher");
  return { watcher: getWatcher(id) };
});
