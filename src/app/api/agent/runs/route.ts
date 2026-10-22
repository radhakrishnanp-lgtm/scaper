import { handler } from "@/server/api";
import { listAgentRuns } from "@/server/repo/agent";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  return { runs: listAgentRuns(Number(sp.get("limit") ?? 30), sp.get("q")?.trim().slice(0, 200) || undefined) };
});
