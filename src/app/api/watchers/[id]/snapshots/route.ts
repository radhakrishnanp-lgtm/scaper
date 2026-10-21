import { handler, idParam, notFound } from "@/server/api";
import { getWatcher, listSnapshots } from "@/server/repo/watchers";

export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!getWatcher(id)) throw notFound("Watcher");
  const sp = req.nextUrl.searchParams;
  return listSnapshots(id, { limit: Number(sp.get("limit") ?? 30), before: sp.get("before") ?? undefined, changedOnly: sp.get("changed") === "1" });
});
