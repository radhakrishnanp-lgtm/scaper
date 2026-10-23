import { handler, idParam, notFound } from "@/server/api";
import { stopHelper } from "@/server/ai/team";
import { audit } from "@/server/repo/events";
import { getWorker } from "@/server/repo/team";

type Ctx = { params: Promise<{ id: string; wid: string }> };

/** Stops one helper agent; the supervisor sees it as stopped in its next status check. */
export const POST = handler(async (_req, { params }: Ctx) => {
  const p = await params;
  const w = getWorker(idParam.parse(p.wid));
  if (!w || w.team_id !== idParam.parse(p.id)) throw notFound("Helper");
  const stopped = stopHelper(w.id, "Stopped by you.");
  if (stopped) audit("agent.helper_stopped", { runId: w.team_id, helper: w.name });
  return { stopped };
});
