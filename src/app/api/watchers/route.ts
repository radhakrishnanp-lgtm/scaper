import { handler, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { createWatcher, listWatchers } from "@/server/repo/watchers";
import { watcherSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({ watchers: listWatchers() }));

export const POST = handler(async (req) => {
  const w = createWatcher(await readJson(req, watcherSchema));
  audit("watcher.created", { watcherId: w.id, by: "user" });
  return { watcher: w };
});
