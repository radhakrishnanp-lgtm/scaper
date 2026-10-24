import { handler, idParam, notFound } from "@/server/api";
import { stopAgent } from "@/server/ai/agent";
import { agentThread, deleteAgentRun, getAgentRun } from "@/server/repo/agent";
import { audit } from "@/server/repo/events";
import { getReview } from "@/server/repo/knowledge";
import { listWorkers, readTeamMemory } from "@/server/repo/team";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const run = getAgentRun(idParam.parse((await params).id));
  if (!run) throw notFound("Agent run");
  const workers = run.private ? [] : listWorkers(run.id);
  const memory = run.private ? [] : readTeamMemory(run.id);
  return { run, thread: agentThread(run.id), team: workers.length || memory.length ? { workers, memory } : null, review: run.private ? null : getReview(run.id) };
});

/** Deletes one run; a running one is stopped first. Follow-ups keep the rest of their conversation. */
export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!getAgentRun(id)) throw notFound("Agent run");
  stopAgent(id);
  deleteAgentRun(id);
  audit("agent.deleted", { runId: id });
  return { ok: true };
});
