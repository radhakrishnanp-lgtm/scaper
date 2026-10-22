import { handler, readJson } from "@/server/api";
import { createDealSearch, listDealSearches } from "@/server/repo/deal-searches";
import { audit } from "@/server/repo/events";
import { dealSearchSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({ searches: listDealSearches().map((s) => ({ ...s, seen: s.seen.length })) }));

export const POST = handler(async (req) => {
  const search = createDealSearch(await readJson(req, dealSearchSchema));
  audit("deal_search.created", { id: search.id });
  return { search };
});
