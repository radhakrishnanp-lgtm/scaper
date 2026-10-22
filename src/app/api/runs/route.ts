import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { deleteRuns, listRuns } from "@/server/repo/scrapes";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  return listRuns({
    limit: Number(sp.get("limit") ?? 25), before: sp.get("before") ?? undefined, recipeId: sp.get("recipeId") ?? undefined,
    status: sp.get("status") ?? undefined, q: sp.get("q") ?? undefined,
  });
});

/** Bulk delete: {ids: [...]} */
export const DELETE = handler(async (req) => {
  const { ids } = await readJson(req, z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }));
  return { removed: deleteRuns(ids) };
});
