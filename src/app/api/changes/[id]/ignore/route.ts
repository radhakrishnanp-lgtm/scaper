import { z } from "zod";
import { handler, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { db } from "@/server/db";
import { triageChanges } from "@/server/repo/watchers";
import { ignoreFromFeedback } from "@/server/watch/runner";

const body = z.object({ lines: z.array(z.string().trim().min(1).max(200)).min(1).max(20) });

/** "Not useful" → ignore these phrases on this watcher from now on (history is kept, the next check won't report them). */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const snap = db().prepare("SELECT watcher_id FROM snapshots WHERE id = ?").get(id) as { watcher_id: string } | undefined;
  if (!snap) throw notFound("Change");
  const { lines } = await readJson(req, body);
  const w = ignoreFromFeedback(snap.watcher_id, lines);
  if (!w) throw notFound("Watcher");
  triageChanges([id], { feedback: "not_useful", reviewed: true, important: false });
  audit("watcher.ignore_added", { watcherId: w.id, lines: lines.length });
  return { watcher: { id: w.id, ignoreLines: w.ignore_lines } };
});
