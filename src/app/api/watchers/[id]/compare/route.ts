import { handler, HttpError, idParam, notFound } from "@/server/api";
import { getSnapshot, getWatcher, previousSnapshot } from "@/server/repo/watchers";

/** Full text of two snapshots for the diff viewer. Without `a`, compares `b` with the snapshot before it. */
export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!getWatcher(id)) throw notFound("Watcher");
  const sp = req.nextUrl.searchParams;
  const b = getSnapshot(id, idParam.parse(sp.get("b")));
  if (!b) throw notFound("Snapshot");
  const a = sp.get("a") ? getSnapshot(id, idParam.parse(sp.get("a"))) : previousSnapshot(id, b.created_at);
  if (sp.get("a") && !a) throw new HttpError(404, "not_found", "Snapshot not found.");
  const strip = (s: typeof b | null) => s && { id: s.id, content: s.content, created_at: s.created_at, screenshot: s.screenshot, visual_diff: s.visual_diff, visual_change: s.visual_change, value: s.value, verdict: s.verdict };
  return { a: strip(a), b: strip(b) };
});
