import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { getWatcher } from "@/server/repo/watchers";
import { checkWatcher } from "@/server/watch/runner";

/** "Check now" from the UI. */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  rateLimit(`check:${id}`, 6, 3);
  const w = getWatcher(id);
  if (!w) throw notFound("Watcher");
  const outcome = await checkWatcher(w);
  return { outcome, watcher: getWatcher(id) };
});
