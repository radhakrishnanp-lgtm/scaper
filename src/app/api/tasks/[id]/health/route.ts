import { handler, idParam, notFound } from "@/server/api";
import { taskHealth } from "@/server/ops/health";
import { getRecipe } from "@/server/repo/scrapes";

export const dynamic = "force-dynamic";

/** Health tab: status strip, last 200 runs, usual row range, duration percentiles, data issues and a waiting repair. */
export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  return taskHealth(task);
});
