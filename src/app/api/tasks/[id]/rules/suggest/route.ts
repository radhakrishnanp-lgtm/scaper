import { z } from "zod";
import { handler, HttpError, idParam, notFound, rateLimit, readJson } from "@/server/api";
import { suggestRulesWithAi } from "@/server/ai/rules";
import { getRecipe, lastGoodRun } from "@/server/repo/scrapes";
import { mainDatasetIndex } from "@/server/tasks/engine";
import { suggestRules } from "@/lib/validation";

const body = z.object({ ai: z.boolean().default(false) }).default({ ai: false });

/** Data checks that describe the last good run: from the data itself, or written by your AI. */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  const { ai } = await readJson(req, body);
  const run = lastGoodRun(task.id);
  const ds = run?.result?.datasets[mainDatasetIndex(run.result.datasets)];
  if (!run || !ds?.rows.length) throw new HttpError(400, "no_data", "Run the task once so there's data to learn from.");
  const keyFields = task.options.monitor.keyFields.length ? task.options.monitor.keyFields : task.options.dedupeBy;
  if (!ai) return { rules: suggestRules(ds, { keyFields }), fromAi: 0, runId: run.id, rows: ds.rows.length };
  rateLimit("ai:rules", 6, 3);
  const out = await suggestRulesWithAi(ds, { name: task.name, description: task.description, keyFields });
  return { ...out, runId: run.id, rows: ds.rows.length };
});
