import "server-only";
import { taskOptionsSchema, type ExtractSpec, type FetchMode } from "@/lib/schemas";
import { runDealSearch, refreshProduct, trackProduct } from "../deals/tracker";
import { createBackup, pruneBackups } from "../ops/backup";
import { getProduct } from "../repo/products";
import { getRecipe, recordRecipeRun, type ScrapeRun } from "../repo/scrapes";
import { getSettings } from "../repo/settings";
import { getWatcher } from "../repo/watchers";
import { runTask } from "../tasks/engine";
import { checkWatcher } from "../watch/runner";
import { syncRunToSheet } from "../integrations/sheets";
import { runHeal } from "../ops/heal";
import { jobFailure, registerJobHandler, type JobContext } from "./queue";

const hooks = (ctx: JobContext) => ({ signal: ctx.signal, log: ctx.log, progress: ctx.progress });

function runSummary(run: ScrapeRun) {
  return {
    runId: run.id, status: run.status, rows: run.row_count, pages: run.page_count, durationMs: run.duration_ms,
    files: run.result?.files ?? [], issues: run.result?.quality?.issues ?? [],
    diagnosis: run.diagnosis ? { code: run.diagnosis.code, title: run.diagnosis.title, action: run.diagnosis.action ?? null } : null,
    validation: run.validation,
    monitor: run.result?.monitor ? { added: run.result.monitor.added, removed: run.result.monitor.removed } : null,
  };
}

function failIfBad(run: ScrapeRun) {
  if (run.status === "error" || run.status === "blocked") {
    throw jobFailure(run.error ?? "The run failed.", runSummary(run), run.status === "blocked");
  }
}

let registered = false;

/** Connects each job kind to the code that does the work. */
export function registerHandlers() {
  if (registered) return;
  registered = true;

  registerJobHandler("task", async (ctx) => {
    const taskId = String(ctx.job.input.taskId ?? "");
    const r = getRecipe(taskId);
    if (!r) throw jobFailure("This task was deleted.", null, true);
    const scheduled = ctx.job.trigger === "schedule";
    // Scheduled runs always leave a CSV behind unless the task chose its own formats.
    const options = scheduled && !r.options.output.files.length ? { ...r.options, output: { ...r.options.output, files: ["csv" as const] } } : r.options;
    ctx.log("info", `Running task "${r.name}".`);
    // Failure alerts (grouped into one per problem) and repairs happen after the run; see ops/after-run.
    const run = await runTask({ url: r.url, mode: r.mode, extract: r.extract, options, recipeId: r.id, taskName: r.name, jobId: ctx.job.id, version: r.version, trigger: ctx.job.trigger }, hooks(ctx));
    recordRecipeRun(r.id, run.status);
    failIfBad(run);
    return runSummary(run);
  });

  registerJobHandler("heal", async (ctx) => {
    const { taskId, runId, reason } = ctx.job.input as { taskId: string; runId?: string | null; reason?: string };
    const out = await runHeal(taskId, runId ?? null, reason ?? "Asked for a repair.", { signal: ctx.signal, log: ctx.log });
    if (out.status === "failed") throw jobFailure(out.error, { taskId }, true);
    return { taskId, status: out.status, proposalId: out.proposalId, passed: out.check.passed };
  });

  registerJobHandler("sheets", async (ctx) => {
    const { runId } = ctx.job.input as { runId: string };
    const out = await syncRunToSheet(runId, { log: ctx.log });
    return out;
  });

  registerJobHandler("scrape", async (ctx) => {
    const spec = ctx.job.input as { url: string; mode: FetchMode; extract: ExtractSpec; options?: unknown; screenshot?: boolean; recipeId?: string | null };
    const options = spec.options ? taskOptionsSchema.parse(spec.options) : undefined;
    const run = await runTask({ url: spec.url, mode: spec.mode, extract: spec.extract, options, screenshot: spec.screenshot, recipeId: spec.recipeId ?? null, jobId: ctx.job.id }, hooks(ctx));
    failIfBad(run);
    return runSummary(run);
  });

  registerJobHandler("watch", async (ctx) => {
    const w = getWatcher(String(ctx.job.input.watcherId ?? ""));
    if (!w) throw jobFailure("This watcher was deleted.", null, true);
    const out = await checkWatcher(w, hooks(ctx));
    const result = { status: out.status, changed: out.changed, triggered: out.triggered, message: out.message, value: out.value, visualChange: out.visualChange ?? null, snapshotId: out.snapshotId ?? null };
    if (out.status !== "ok") throw jobFailure(out.message, result, true);
    return result;
  });

  registerJobHandler("product", async (ctx) => {
    const p = getProduct(String(ctx.job.input.productId ?? ""));
    if (!p) throw jobFailure("This product was deleted.", null, true);
    const out = await refreshProduct(p, { signal: ctx.signal });
    if (!out.ok) throw jobFailure(out.error, { productId: p.id }, true);
    ctx.log("info", `Price ${out.product.current_price ?? "?"}${out.alerts ? `, ${out.alerts} alert(s) sent` : ""}.`);
    return { productId: p.id, price: out.product.current_price, alerts: out.alerts };
  });

  registerJobHandler("bulk_products", async (ctx) => {
    const { urls, intervalMinutes, tags } = ctx.job.input as { urls: string[]; intervalMinutes: number; tags?: string[] };
    const results: { url: string; ok: boolean; created: boolean; error?: string; productId?: string }[] = [];
    for (const [i, url] of urls.entries()) {
      ctx.throwIfCancelled();
      ctx.progress({ done: i, total: urls.length, label: url });
      try {
        const r = await trackProduct({ url, intervalMinutes, tags });
        results.push({ url, ok: !r.error, created: r.created, error: r.error, productId: r.product.id });
        ctx.log(r.error ? "warn" : "info", `${url}: ${r.error ?? (r.created ? "tracking" : "already tracked")}`);
      } catch (e) {
        results.push({ url, ok: false, created: false, error: (e as Error).message });
        ctx.log("warn", `${url}: ${(e as Error).message}`);
      }
    }
    ctx.progress({ done: urls.length, total: urls.length, label: "Finished" });
    return { added: results.filter((r) => r.created).length, failed: results.filter((r) => !r.ok).length, results };
  });

  registerJobHandler("deal_search", async (ctx) => {
    const id = String(ctx.job.input.dealSearchId ?? "");
    const out = await runDealSearch(id, { signal: ctx.signal, log: ctx.log });
    return out;
  });

  registerJobHandler("backup", async (ctx) => {
    const b = await createBackup(ctx.job.trigger === "schedule" ? "auto" : "manual");
    const removed = await pruneBackups(getSettings().data.keepBackups);
    ctx.log("info", `Saved ${b.name} (${Math.round(b.size / 1024)} KB)${removed ? `, removed ${removed} old backup(s)` : ""}.`);
    return { ...b, removed };
  });
}
