import { handler, HttpError, notFound, rateLimit, readJson } from "@/server/api";
import { startAgent } from "@/server/ai/agent";
import { parseModelChoice } from "@/server/ai/client";
import { SUPERVISOR_DEFS } from "@/server/ai/team";
import { toolCatalog } from "@/server/ai/tools";
import { getAgentRun } from "@/server/repo/agent";
import { getSettings } from "@/server/repo/settings";
import { agentRequestSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/** What the agent can do, and how it is set up (approval mode, step limit). */
export const GET = handler(async () => {
  const ai = getSettings().ai;
  const team = ai.team.enabled ? SUPERVISOR_DEFS.map((d) => ({ name: d.function.name, group: "Team", changes: false, description: d.function.description })) : [];
  return { tools: [...toolCatalog(), ...team], team: ai.team, approval: ai.agentApproval, maxSteps: ai.agentMaxSteps, privateMode: getSettings().data.privateMode };
});

export const POST = handler(async (req) => {
  rateLimit("agent", 10, 3);
  const { prompt, useFastModel, model, followUpOf, private: priv } = await readJson(req, agentRequestSchema);
  if (followUpOf) {
    const parent = getAgentRun(followUpOf);
    if (!parent) throw notFound("Conversation");
    if (parent.status === "running") throw new HttpError(409, "busy", "Wait for the previous answer before asking a follow-up.");
  }
  return { run: startAgent({ prompt, model: parseModelChoice(model, useFastModel), followUpOf, private: priv }) };
});
