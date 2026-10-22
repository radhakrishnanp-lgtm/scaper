import { z } from "zod";
import { handler, HttpError, idParam, notFound, rateLimit, readJson } from "@/server/api";
import { suggestSelectors } from "@/server/ai/suggest";
import { extractWithSelectors } from "@/server/extract/selectors";
import { fetchPage } from "@/server/fetcher";
import { audit } from "@/server/repo/events";
import { getRecipe, updateRecipe } from "@/server/repo/scrapes";
import { extractSchema } from "@/lib/schemas";

const body = z.object({ apply: extractSchema.optional() }).default({});

/**
 * "Fix with AI": when a site changes its layout and a task's selectors stop matching, your model proposes new
 * selectors for the same columns, tested on the live page. Nothing is saved until you apply them.
 */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  const { apply } = await readJson(req, body);
  // Second step: you looked at the proposal and chose to use it. Only the extraction changes.
  if (apply) {
    const updated = updateRecipe(task.id, { ...task, scheduleMinutes: task.schedule_minutes, cron: task.cron, extract: apply });
    audit("task.healed", { taskId: task.id });
    return { task: updated };
  }
  rateLimit("ai:heal", 6, 3);
  if (task.extract.type !== "selectors") throw new HttpError(400, "not_selectors", "Only tasks that use selectors can be fixed this way. AI and Auto tasks adapt by themselves.");
  const url = task.options.categories[0]?.url ?? task.url;
  const page = await fetchPage(url, task.mode, { scroll: task.mode === "browser" });
  const before = extractWithSelectors(page.html, page.finalUrl, task.extract).rows.length;
  const fields = task.extract.fields;
  const describe = `${task.extract.itemSelector ? "One row per item. " : ""}Columns (keep exactly these names): ${fields.map((f) => `${f.name}${f.attr !== "text" ? ` (${f.attr})` : ""}`).join(", ")}.${task.description ? ` Context: ${task.description.slice(0, 200)}` : ""}`;
  const s = await suggestSelectors(page.html, page.finalUrl, describe, "main");
  // Keep each column's transforms and options; only the selector (and attribute) change.
  const merged = fields.map((f) => {
    const hit = s.fields.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    return hit ? { ...f, selector: hit.selector, attr: hit.attr || f.attr } : f;
  });
  const after = extractWithSelectors(page.html, page.finalUrl, { itemSelector: s.itemSelector, fields: merged });
  return {
    url: page.finalUrl, before, after: after.rows.length,
    extract: { type: "selectors", itemSelector: s.itemSelector, fields: merged },
    sample: after.rows.slice(0, 8), note: s.note,
    unchanged: merged.filter((f, i) => f.selector === fields[i]!.selector).map((f) => f.name),
  };
});
