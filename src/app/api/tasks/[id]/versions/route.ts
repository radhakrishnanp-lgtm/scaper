import { handler, idParam, notFound } from "@/server/api";
import { getRecipe, taskVersionData } from "@/server/repo/scrapes";
import { ensureBaseline, listVersions } from "@/server/repo/versions";
import { db } from "@/server/db";

/** Every saved setup of the task, newest first, with how many runs used each one. */
export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  ensureBaseline("task", task.id, () => taskVersionData(task));
  const runs = db().prepare("SELECT version, COUNT(*) n, SUM(status IN ('ok','partial')) ok FROM scrape_runs WHERE recipe_id = ? AND version IS NOT NULL GROUP BY version").all(task.id) as { version: number; n: number; ok: number }[];
  const byVersion = new Map(runs.map((r) => [r.version, r]));
  return { current: task.version, items: listVersions("task", task.id).map((v) => ({ ...v, runs: byVersion.get(v.version)?.n ?? 0, okRuns: byVersion.get(v.version)?.ok ?? 0 })) };
});
