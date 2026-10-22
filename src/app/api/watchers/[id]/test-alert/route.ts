import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { deliver } from "@/server/notify";
import { getWatcher } from "@/server/repo/watchers";

/** Sends a sample alert through this watcher's channels. */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  rateLimit("test-alert", 6, 2);
  const w = getWatcher(idParam.parse((await params).id));
  if (!w) throw notFound("Watcher");
  await deliver({ kind: "watcher", title: `${w.name} (test)`, body: "This is a test alert. Real alerts look like this.\n+ an added line\n- a removed line", url: w.url, watcherId: w.id }, w.notify);
  const channels = Object.entries(w.notify).filter(([, on]) => on).map(([c]) => c);
  return { ok: true, message: `Sent to ${channels.join(", ") || "the inbox only"}. Check Activity → Logs if a channel did not arrive.` };
});
