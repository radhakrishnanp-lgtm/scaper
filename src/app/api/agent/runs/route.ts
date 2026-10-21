import { handler } from "@/server/api";
import { listAgentRuns } from "@/server/repo/agent";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => ({ runs: listAgentRuns(Number(req.nextUrl.searchParams.get("limit") ?? 20)) }));
