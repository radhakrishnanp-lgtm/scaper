import { handler, idParam, notFound } from "@/server/api";
import { stopAgent } from "@/server/ai/agent";
import { getAgentRun } from "@/server/repo/agent";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!getAgentRun(id)) throw notFound("Agent run");
  return { stopped: stopAgent(id), run: getAgentRun(id) };
});
