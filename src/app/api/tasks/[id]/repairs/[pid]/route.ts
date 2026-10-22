import { z } from "zod";
import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { enqueue } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { decideProposal, getProposal } from "@/server/repo/heal";
import { getRecipe, updateRecipe } from "@/server/repo/scrapes";

const body = z.object({ action: z.enum(["apply", "dismiss"]), runAfter: z.boolean().default(true) });

/** Apply or dismiss a repair the AI prepared. Applying saves a new version and, by default, runs the task. */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string; pid: string }> }) => {
  const p = await params;
  const task = getRecipe(idParam.parse(p.id));
  const proposal = getProposal(idParam.parse(p.pid));
  if (!task || !proposal || proposal.recipe_id !== task.id) throw notFound("Repair");
  if (proposal.status !== "pending") throw new HttpError(409, "decided", "This repair was already applied or dismissed.");
  const { action, runAfter } = await readJson(req, body);
  if (action === "dismiss") {
    decideProposal(proposal.id, "dismissed");
    audit("task.repair_dismissed", { taskId: task.id });
    return { ok: true };
  }
  if (!proposal.extract) throw new HttpError(400, "no_fix", "This repair has no selectors to apply.");
  const updated = updateRecipe(task.id, { ...task, scheduleMinutes: task.schedule_minutes, cron: task.cron, extract: proposal.extract }, { source: "ai_fix", note: proposal.reason });
  decideProposal(proposal.id, "applied");
  audit("task.repair_applied", { taskId: task.id, version: updated?.version });
  const job = runAfter ? enqueue({ kind: "task", refId: task.id, title: `Task: ${task.name}`, trigger: "repair", input: { taskId: task.id }, unique: true }) : null;
  return { task: updated, jobId: job?.id ?? null };
});
