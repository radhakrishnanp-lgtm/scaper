import "server-only";
import type { Dataset } from "@/lib/types";
import { profileColumn } from "@/lib/validation";
import { aiConfig } from "../ai/client";
import { suggestSelectors } from "../ai/suggest";
import { extractWithSelectors } from "../extract/selectors";
import { fetchPage } from "../fetcher";
import { enqueue } from "../jobs/queue";
import { deliver } from "../notify";
import { audit } from "../repo/events";
import { addProposal, lastAttempt, pendingProposal, type HealCheck } from "../repo/heal";
import { getRecipe, lastGoodRun, updateRecipe, type Task } from "../repo/scrapes";
import { mainDatasetIndex } from "../tasks/engine";

/** How long to wait before preparing another repair for the same task. */
const COOLDOWN_MS = 6 * 60 * 60_000;

const keyFieldsOf = (t: Task) => (t.options.monitor.keyFields.length ? t.options.monitor.keyFields : t.options.dedupeBy);

/**
 * Asks your model for new selectors for the same columns, on the page as it is today.
 * Keeps each column's transforms and options; only selectors (and attributes) change.
 */
export async function proposeFix(task: Task, opts: { signal?: AbortSignal } = {}) {
  if (task.extract.type !== "selectors") throw new Error("Only tasks that use selectors can be repaired this way. AI and Auto tasks adapt by themselves.");
  const url = task.options.categories[0]?.url ?? task.url;
  const page = await fetchPage(url, task.mode, { scroll: task.mode === "browser", steps: task.mode === "browser" ? task.options.steps : undefined, signal: opts.signal });
  const fields = task.extract.fields;
  const before = extractWithSelectors(page.html, page.finalUrl, task.extract).rows.length;
  const describe = `${task.extract.itemSelector ? "One row per item. " : ""}Columns (keep exactly these names): ${fields.map((f) => `${f.name}${f.attr !== "text" ? ` (${f.attr})` : ""}`).join(", ")}.${task.description ? ` Context: ${task.description.slice(0, 200)}` : ""}`;
  const s = await suggestSelectors(page.html, page.finalUrl, describe, "main");
  const merged = fields.map((f) => {
    const hit = s.fields.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    return hit ? { ...f, selector: hit.selector, attr: hit.attr || f.attr } : f;
  });
  const extract = { type: "selectors" as const, itemSelector: s.itemSelector, fields: merged };
  const after = extractWithSelectors(page.html, page.finalUrl, { itemSelector: s.itemSelector, fields: merged });
  return {
    url: page.finalUrl, before, extract, dataset: after, note: s.note || null,
    unchanged: merged.filter((f, i) => f.selector === fields[i]!.selector).map((f) => f.name),
  };
}

/**
 * Compares the proposed selectors' rows with the last good run before anything is applied: enough rows
 * (per page), columns that used to be filled are still filled, and (with key fields) the same items show up.
 */
export function checkAgainstHistory(task: Task, proposal: Awaited<ReturnType<typeof proposeFix>>): HealCheck {
  const rows = proposal.dataset.rows;
  const reasons: string[] = [];
  const prev = lastGoodRun(task.id);
  const prevMain: Dataset | undefined = prev?.result?.datasets[mainDatasetIndex(prev.result.datasets)];
  const perPage = prev && prevMain ? Math.max(1, Math.round(prevMain.rows.length / Math.max(1, prev.page_count))) : null;
  const rowRatio = perPage ? Math.round((rows.length / perPage) * 100) / 100 : null;
  let passed = rows.length > 0;
  if (!rows.length) reasons.push("The new selectors find nothing on today's page either.");
  if (rowRatio !== null && rows.length && rowRatio < 0.5) { passed = false; reasons.push(`Only ${rows.length} rows; the last good run had about ${perPage} per page.`); }

  const fill = proposal.dataset.columns.map((c) => {
    const after = profileColumn(proposal.dataset, c).fill;
    const before = prevMain && prevMain.columns.includes(c) ? profileColumn(prevMain, c).fill : null;
    if (before !== null && before >= 80 && after < before - 30) { passed = false; reasons.push(`"${c}" was filled in ${before}% of rows before, now ${after}%.`); }
    return { column: c, before, after };
  });

  let keyOverlap: number | null = null;
  const keys = keyFieldsOf(task).filter((k) => proposal.dataset.columns.includes(k));
  if (prevMain && keys.length && rows.length) {
    const keyOf = (r: Record<string, unknown>) => JSON.stringify(keys.map((k) => r[k] ?? null));
    const old = new Set(prevMain.rows.map(keyOf));
    keyOverlap = Math.round((rows.filter((r) => old.has(keyOf(r))).length / rows.length) * 100) / 100;
    if (keyOverlap < 0.1) { passed = false; reasons.push(`Almost none of the items match the last good run by ${keys.join(" + ")} (${Math.round(keyOverlap * 100)}%).`); }
  }
  if (passed) reasons.unshift(prevMain ? "Matches the last good run." : "No earlier run to compare with; the new selectors find data on today's page.");
  return {
    passed, url: proposal.url, before: proposal.before, after: rows.length, baselineRows: perPage, rowRatio, keyOverlap, fill, reasons,
    sample: rows.slice(0, 8), note: proposal.note, unchanged: proposal.unchanged,
  };
}

/** Should this run start a repair? Selectors task, pages loaded, data missing or off, and no recent attempt. */
export function shouldHeal(task: Task, signal: { rows: number; okPages: number; aiFallbackPages: number; validationFailed: boolean; belowRange: boolean }) {
  if (task.extract.type !== "selectors" || task.options.heal.mode === "off" || !signal.okPages) return null;
  const reason = !signal.rows ? "The selectors matched nothing."
    : signal.aiFallbackPages ? `The selectors found nothing on ${signal.aiFallbackPages} page(s); the AI read them instead.`
    : signal.validationFailed ? "The data failed its checks."
    : signal.belowRange ? "Far fewer rows than usual."
    : null;
  if (!reason || !aiConfig("main").configured) return null;
  if (pendingProposal(task.id)) return null;
  const last = lastAttempt(task.id);
  if (last && Date.now() - Date.parse(last.created_at) < COOLDOWN_MS) return null;
  return reason;
}

export function queueHeal(task: Task, runId: string | null, reason: string) {
  return enqueue({ kind: "heal", refId: task.id, title: `AI repair: ${task.name}`, trigger: "auto", input: { taskId: task.id, runId, reason }, unique: true });
}

/**
 * Background repair: propose new selectors, check them against the last good run, then either apply them
 * (auto mode, check passed: the old setup stays in version history and the task runs again) or keep them for you.
 */
export async function runHeal(taskId: string, runId: string | null, reason: string, hooks: { signal?: AbortSignal; log?: (l: "info" | "warn", m: string) => void } = {}) {
  const task = getRecipe(taskId);
  if (!task) throw new Error("This task was deleted.");
  const log = hooks.log ?? (() => undefined);
  const channels = task.options.monitor.channels;
  try {
    log("info", `Asking your model for new selectors. Reason: ${reason}`);
    const proposal = await proposeFix(task, hooks);
    const check = checkAgainstHistory(task, proposal);
    log(check.passed ? "info" : "warn", `Check against the last good run: ${check.passed ? "passed" : "not passed"}. ${check.reasons.join(" ")}`);
    if (task.options.heal.mode === "auto" && check.passed) {
      const updated = updateRecipe(task.id, { ...task, scheduleMinutes: task.schedule_minutes, cron: task.cron, extract: proposal.extract }, { source: "auto_heal", note: reason });
      const p = addProposal({ recipeId: task.id, runId, status: "applied", reason, extract: proposal.extract, report: check });
      audit("task.auto_healed", { taskId: task.id, version: updated?.version });
      enqueue({ kind: "task", refId: task.id, title: `Task: ${task.name}`, trigger: "repair", input: { taskId: task.id }, unique: true });
      await deliver({ kind: "task", title: `${task.name} was repaired automatically`, body: `${reason}\nYour AI found new selectors (${check.after} rows on today's page) and they match the last good run. The task is running again. You can roll back in the task's Versions tab.`, url: task.url, data: { recipeId: task.id, proposalId: p.id } }, channels);
      return { status: "applied" as const, proposalId: p.id, check };
    }
    const p = addProposal({ recipeId: task.id, runId, status: "pending", reason, extract: proposal.extract, report: check });
    await deliver({ kind: "task", title: `${task.name}: a repair is ready to review`, body: `${reason}\nYour AI prepared new selectors (${check.after} rows on today's page). ${check.passed ? "They match the last good run." : check.reasons.join(" ")} Open the task to review and apply.`, url: task.url, data: { recipeId: task.id, proposalId: p.id } }, channels);
    return { status: "pending" as const, proposalId: p.id, check };
  } catch (e) {
    const message = (e as Error).message;
    addProposal({ recipeId: task.id, runId, status: "failed", reason, error: message });
    log("warn", `Repair failed: ${message}`);
    return { status: "failed" as const, error: message };
  }
}
