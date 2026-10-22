import { handler, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { createRecipe, listRecipes } from "@/server/repo/scrapes";
import { taskSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const tasks = listRecipes({ q: sp.get("q") ?? undefined, tag: sp.get("tag") ?? undefined });
  return { tasks, recipes: tasks, tags: [...new Set(tasks.flatMap((t) => t.tags))].sort() };
});

export const POST = handler(async (req) => {
  const task = createRecipe(await readJson(req, taskSchema));
  audit("task.created", { taskId: task.id });
  return { task, recipe: task };
});
