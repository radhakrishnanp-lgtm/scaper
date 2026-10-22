import { handler, idParam, notFound } from "@/server/api";
import { listProposals } from "@/server/repo/heal";
import { getRecipe } from "@/server/repo/scrapes";

/** Repairs the AI prepared for this task: applied, waiting for you, dismissed or failed. */
export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  return { items: listProposals(task.id) };
});
