import { handler, HttpError, readJson } from "@/server/api";
import { enqueue } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { deleteWatcher, getWatcher, setWatcherEnabled, setWatcherTags } from "@/server/repo/watchers";
import { bulkActionSchema } from "@/lib/schemas";

/** Select many watchers and pause, resume, check, tag or delete them at once. */
export const POST = handler(async (req) => {
  const { ids, action, tag } = await readJson(req, bulkActionSchema);
  if ((action === "tag" || action === "untag") && !tag) throw new HttpError(400, "validation", "Choose a tag.");
  let done = 0;
  for (const id of ids) {
    const w = getWatcher(id);
    if (!w) continue;
    if (action === "pause" || action === "resume") done += setWatcherEnabled(id, action === "resume") ? 1 : 0;
    else if (action === "delete") done += deleteWatcher(id) ? 1 : 0;
    else if (action === "check") { enqueue({ kind: "watch", refId: id, title: `Check: ${w.name}`, input: { watcherId: id }, unique: true, priority: 5 }); done++; }
    else if (action === "tag") done += setWatcherTags(id, [...w.tags, tag!]) ? 1 : 0;
    else if (action === "untag") done += setWatcherTags(id, w.tags.filter((t) => t !== tag)) ? 1 : 0;
  }
  audit("watchers.bulk", { action, count: done });
  return { done };
});
