import { z } from "zod";
import { handler, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { getRecipe, updateRecipe } from "@/server/repo/scrapes";
import { validationRuleSchema } from "@/lib/schemas";

const body = z.object({ rules: z.array(validationRuleSchema).max(40), alert: z.enum(["off", "fail", "warn"]).optional() });

/** Saves a task's data checks (they are part of its setup, so this creates a new version). */
export const PUT = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  const { rules, alert } = await readJson(req, body);
  const updated = updateRecipe(task.id, {
    ...task, scheduleMinutes: task.schedule_minutes, cron: task.cron,
    options: { ...task.options, validation: { rules, alert: alert ?? task.options.validation.alert } },
  }, { source: "edit", note: `Data checks: ${rules.length}` });
  audit("task.rules_updated", { taskId: task.id, rules: rules.length });
  return { task: updated };
});
