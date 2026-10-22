import { handler, idParam, notFound } from "@/server/api";
import { listIssues } from "@/server/repo/quality";
import { getRecipe } from "@/server/repo/scrapes";

export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  const status = req.nextUrl.searchParams.get("status");
  return { items: listIssues(task.id, status === "open" || status === "resolved" ? status : undefined, 200) };
});
