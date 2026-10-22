import { handler, idParam, notFound } from "@/server/api";
import { audit } from "@/server/repo/events";
import { duplicateRecipe } from "@/server/repo/scrapes";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const task = duplicateRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  audit("task.created", { taskId: task.id, from: "duplicate" });
  return { task };
});
