import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { enqueueAndWait } from "@/server/jobs";
import { getDealSearch } from "@/server/repo/deal-searches";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  rateLimit("deals:scan", 10, 3);
  const id = idParam.parse((await params).id);
  const s = getDealSearch(id);
  if (!s) throw notFound("Deal search");
  const job = await enqueueAndWait({ kind: "deal_search", refId: id, title: `Deals: ${s.name}`, input: { dealSearchId: id }, unique: true }, 90_000);
  const after = getDealSearch(id)!;
  return { job, search: { ...after, seen: after.seen.length } };
});
