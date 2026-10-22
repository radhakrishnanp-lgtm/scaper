import { z } from "zod";
import { handler, HttpError, idParam, notFound, rateLimit, readJson } from "@/server/api";
import { checkAgainstHistory, proposeFix } from "@/server/ops/heal";
import { audit } from "@/server/repo/events";
import { decideProposal, getProposal } from "@/server/repo/heal";
import { getRecipe, updateRecipe } from "@/server/repo/scrapes";
import { extractSchema } from "@/lib/schemas";

const body = z.object({ apply: extractSchema.optional(), proposalId: z.string().uuid().optional() }).default({});

/**
 * "Fix with AI": when a site changes its layout and a task's selectors stop matching, your model proposes new
 * selectors for the same columns, tested on the live page and checked against the last good run.
 * Nothing is saved until you apply them; applying saves a new version you can roll back.
 */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  const { apply, proposalId } = await readJson(req, body);
  if (apply) {
    const updated = updateRecipe(task.id, { ...task, scheduleMinutes: task.schedule_minutes, cron: task.cron, extract: apply }, { source: "ai_fix", note: "New selectors from Fix with AI" });
    if (proposalId && getProposal(proposalId)?.recipe_id === task.id) decideProposal(proposalId, "applied");
    audit("task.healed", { taskId: task.id, version: updated?.version });
    return { task: updated };
  }
  rateLimit("ai:heal", 6, 3);
  if (task.extract.type !== "selectors") throw new HttpError(400, "not_selectors", "Only tasks that use selectors can be fixed this way. AI and Auto tasks adapt by themselves.");
  const proposal = await proposeFix(task);
  const check = checkAgainstHistory(task, proposal);
  return { ...check, extract: proposal.extract };
});
