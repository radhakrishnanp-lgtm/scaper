import { handler, idParam, notFound } from "@/server/api";
import { getAgentRun } from "@/server/repo/agent";

export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const run = getAgentRun(idParam.parse((await params).id));
  if (!run) throw notFound("Agent run");
  return { run };
});
