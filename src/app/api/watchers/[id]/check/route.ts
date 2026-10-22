import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { enqueueAndWait } from "@/server/jobs";
import { getWatcher } from "@/server/repo/watchers";

/** "Check now": queued with high priority, and the answer comes back when the check is done. */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  rateLimit(`check:${id}`, 6, 3);
  const w = getWatcher(id);
  if (!w) throw notFound("Watcher");
  const job = await enqueueAndWait({ kind: "watch", refId: id, title: `Check: ${w.name}`, input: { watcherId: id }, unique: true }, 90_000);
  const r = job.result as { status?: string; message?: string; changed?: boolean; triggered?: boolean; value?: number | null } | null;
  const outcome = r ?? { status: job.status === "failed" ? "error" : "queued", message: job.error ?? "Still running. See the Runs page.", changed: false, triggered: false, value: null };
  return { outcome, job, watcher: getWatcher(id) };
});
