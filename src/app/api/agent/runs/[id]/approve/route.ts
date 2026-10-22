import { z } from "zod";
import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { answerApproval } from "@/server/ai/agent";
import { getAgentRun } from "@/server/repo/agent";
import { audit } from "@/server/repo/events";

const schema = z.object({ decision: z.enum(["allow", "allow_all", "deny"]) });

/** Your answer to "the agent wants to …": allow once, allow everything for this request, or decline. */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const run = getAgentRun(id);
  if (!run) throw notFound("Conversation");
  const { decision } = await readJson(req, schema);
  if (!run.pending || !answerApproval(id, decision)) throw new HttpError(409, "not_waiting", "The agent is not waiting for an answer any more.");
  audit("agent.approval", { runId: id, tool: run.pending.tool, decision });
  return { ok: true };
});
