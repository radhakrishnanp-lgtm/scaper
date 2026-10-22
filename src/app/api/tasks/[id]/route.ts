import { z } from "zod";
import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { listJobs } from "@/server/repo/jobs";
import { deleteRecipe, getRecipe, runTrend, seenCount, setRecipeSchedulePaused, updateRecipe } from "@/server/repo/scrapes";
import { db } from "@/server/db";
import { pendingProposal } from "@/server/repo/heal";
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
  const openIssues = (db().prepare("SELECT COUNT(*) c FROM quality_issues WHERE recipe_id = ? AND status = 'open'").get(id) as { c: number }).c;
  const versions = (db().prepare("SELECT COUNT(*) c FROM config_versions WHERE kind = 'task' AND ref_id = ?").get(id) as { c: number }).c;
  return { task, recipe: task, trend: runTrend(id), jobs: listJobs({ refId: id, limit: 10 }).items, seen: seenCount(id), nextRuns, pendingRepair: pendingProposal(id), openIssues, versions };
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

/** Pause or resume the schedule without changing it, or change how broken selectors are repaired. */
export const PATCH = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const { paused, heal } = await readJson(req, z.object({ paused: z.boolean().optional(), heal: z.enum(["off", "ask", "auto"]).optional() }));
  let task = getRecipe(id);
  if (!task) throw notFound("Task");
  if (paused !== undefined) {
    task = setRecipeSchedulePaused(id, paused)!;
    audit(paused ? "task.paused" : "task.resumed", { taskId: id });
  }
  if (heal && heal !== task.options.heal.mode) {
    task = updateRecipe(id, { ...task, scheduleMinutes: task.schedule_minutes, cron: task.cron, options: { ...task.options, heal: { mode: heal } } }, { source: "edit", note: `Repair mode: ${heal}` })!;
    audit("task.heal_mode", { taskId: id, mode: heal });
  }
  return { task };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteRecipe(id)) throw notFound("Task");
  audit("task.deleted", { taskId: id });
  return { ok: true };
});
