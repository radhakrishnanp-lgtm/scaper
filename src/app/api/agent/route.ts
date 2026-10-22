import { handler, HttpError, notFound, rateLimit, readJson } from "@/server/api";
import { startAgent } from "@/server/ai/agent";
import { getAgentRun } from "@/server/repo/agent";
import { agentRequestSchema } from "@/lib/schemas";

export const POST = handler(async (req) => {
  rateLimit("agent", 10, 3);
  const { prompt, useFastModel, followUpOf } = await readJson(req, agentRequestSchema);
  if (followUpOf) {
    const parent = getAgentRun(followUpOf);
    if (!parent) throw notFound("Conversation");
    if (parent.status === "running") throw new HttpError(409, "busy", "Wait for the previous answer before asking a follow-up.");
  }
  return { run: startAgent(prompt, useFastModel, followUpOf) };
});
