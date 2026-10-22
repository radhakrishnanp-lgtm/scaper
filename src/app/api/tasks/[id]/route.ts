import { z } from "zod";
import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { listJobs } from "@/server/repo/jobs";
import { deleteRecipe, getRecipe, runTrend, seenCount, setRecipeSchedulePaused, updateRecipe } from "@/server/repo/scrapes";
import { previewCron } from "@/server/watch/schedule";
import { taskSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const task = getRecipe(id);
  if (!task) throw notFound("Task");
  let nextRuns: string[] = [];
  try {
    nextRuns = task.cron ? previewCron(task.cron, 5) : task.next_run_at ? [task.next_run_at] : [];
  } catch { /* invalid cron is reported when saving */ }
  return { task, recipe: task, trend: runTrend(id), jobs: listJobs({ refId: id, limit: 10 }).items, seen: seenCount(id), nextRuns };
});

export const PUT = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  let task;
  try {
    task = updateRecipe(id, await readJson(req, taskSchema));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Invalid cron")) throw new HttpError(400, "validation", e.message);
    throw e;
  }
  if (!task) throw notFound("Task");
  audit("task.updated", { taskId: id });
  return { task, recipe: task };
});

/** Pause or resume the schedule without changing it. */
export const PATCH = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const { paused } = await readJson(req, z.object({ paused: z.boolean() }));
  const task = setRecipeSchedulePaused(id, paused);
  if (!task) throw notFound("Task");
  audit(paused ? "task.paused" : "task.resumed", { taskId: id });
  return { task };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteRecipe(id)) throw notFound("Task");
  audit("task.deleted", { taskId: id });
  return { ok: true };
});
