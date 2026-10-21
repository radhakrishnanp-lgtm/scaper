import { handler } from "@/server/api";
import { listRuns } from "@/server/repo/scrapes";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  return listRuns({ limit: Number(sp.get("limit") ?? 25), before: sp.get("before") ?? undefined, recipeId: sp.get("recipeId") ?? undefined });
});
