import { handler, idParam, notFound, readJson } from "@/server/api";
import { deleteDealSearch, getDealSearch, updateDealSearch } from "@/server/repo/deal-searches";
import { dealSearchSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const s = getDealSearch(idParam.parse((await params).id));
  if (!s) throw notFound("Deal search");
  return { search: { ...s, seen: s.seen.length } };
});

export const PUT = handler(async (req, { params }: Ctx) => {
  const s = updateDealSearch(idParam.parse((await params).id), await readJson(req, dealSearchSchema));
  if (!s) throw notFound("Deal search");
  return { search: { ...s, seen: s.seen.length } };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  if (!deleteDealSearch(idParam.parse((await params).id))) throw notFound("Deal search");
  return { ok: true };
});
