import "server-only";
import type { TaskOptions } from "@/lib/schemas";
import type { ValidationReport } from "@/lib/validation";
import { emitWebhook } from "../integrations/webhooks";
import { enqueue } from "../jobs/queue";
import { deliver } from "../notify";
import { listIssues, trackIssues } from "../repo/quality";
import { getRecipe, runHistory, setHealthAlerted, setRunValidation, type ScrapeRun } from "../repo/scrapes";
import type { RunHooks, TaskRunInput } from "../tasks/engine";
import { queueHeal, shouldHeal } from "./heal";

type Ctx = {
  run: ScrapeRun; input: TaskRunInput; options: TaskOptions; validation: ValidationReport | null;
  expected: { low: number; high: number; median: number } | null; aiFallbackPages: number; log: NonNullable<RunHooks["log"]>;
};

const failed = (s: string) => s === "error" || s === "blocked";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Runs that alert: scheduled, started by a script, or a repair re-run. Manual runs only update the health state. */
const ALERTING = new Set(["schedule", "api", "repair", "mcp", "agent"]);

/**
 * Everything that happens after a task run is saved: validation issues tracked across runs, health alerts
 * (failure streaks, too few rows, too slow, outside the usual range, recovered) sent once per problem,
 * and an AI repair queued when the selectors broke.
 */
export async function afterTaskRun({ run, input, options: o, validation, expected, aiFallbackPages, log }: Ctx) {
  const recipeId = input.recipeId!;
  const task = getRecipe(recipeId);
  if (!task) return;
  const name = input.taskName ?? task.name;
  const channels = o.monitor.channels;
  const alerting = ALERTING.has(input.trigger ?? "manual");

  // 1. Validation issues: new when a rule starts failing, resolved when it passes again.
  if (validation) {
    const { opened, resolved } = trackIssues(recipeId, run.id, validation.results);
    const summary = { status: validation.status, score: validation.score, failed: validation.counts.fail, warned: validation.counts.warn, opened: opened.length, resolved: resolved.length };
    setRunValidation(run.id, summary);
    run.validation = summary;
    if (opened.length || resolved.length) log("info", `Data issues: ${opened.length} new, ${resolved.length} resolved.`);
    if (o.validation.alert !== "off") {
      const alertable = opened.filter((i) => o.validation.alert === "warn" || i.severity === "fail");
      if (alertable.length) {
        await deliver({ kind: "task", title: `${name}: ${plural(alertable.length, "new data issue")}`, body: alertable.slice(0, 6).map((i) => `• ${i.label}: ${i.detail}`).join("\n"), url: task.url, data: { recipeId, runId: run.id, issues: alertable.length } }, channels);
      }
      if (resolved.length && !listIssues(recipeId, "open").length) {
        await deliver({ kind: "task", title: `${name}: data checks pass again`, body: `${plural(resolved.length, "issue")} resolved in the latest run.`, url: task.url, data: { recipeId, runId: run.id } }, channels);
      }
    }
  }

  // 2. Health: one alert per problem, then quiet until the task recovers.
  const problems: string[] = [];
  const history = runHistory(recipeId, 25);
  let streak = 0;
  for (const r of history) { if (failed(r.status)) streak++; else break; }
  const okish = run.status === "ok" || run.status === "partial";
  if (failed(run.status) && streak >= o.health.failStreak) problems.push(`${streak > 1 ? `Failed ${streak} times in a row` : "The run failed"}: ${run.diagnosis?.title ?? run.error ?? "unknown error"}.`);
  if (okish && o.health.minRows !== null && run.row_count < o.health.minRows) problems.push(`Only ${run.row_count} rows (you expect at least ${o.health.minRows}).`);
  if (okish && expected && o.health.anomaly && run.row_count < expected.low) problems.push(`${run.row_count} rows, below the usual range of ${expected.low}–${expected.high}.`);
  if (o.health.maxDurationSeconds !== null && run.duration_ms > o.health.maxDurationSeconds * 1000) problems.push(`Took ${Math.round(run.duration_ms / 1000)} s (your limit is ${o.health.maxDurationSeconds} s).`);

  if (problems.length) {
    if (!task.health_alerted_at && alerting) {
      setHealthAlerted(recipeId, new Date().toISOString());
      const next = run.diagnosis?.action ? `\nSuggested next step: ${run.diagnosis.action.label}.` : "";
      await deliver({ kind: "task", title: `${name} needs attention`, body: `${problems.join("\n")}${next}`, url: task.url, data: { recipeId, runId: run.id, health: "unhealthy" } }, channels);
    }
  } else if (okish && task.health_alerted_at) {
    setHealthAlerted(recipeId, null);
    if (o.health.recovered) {
      await deliver({ kind: "task", title: `${name} is healthy again`, body: `The latest run worked: ${plural(run.row_count, "row")}.`, url: task.url, data: { recipeId, runId: run.id, health: "recovered" } }, { ...channels, desktop: false });
    }
  }

  if (failed(run.status) && o.output.webhook) {
    await emitWebhook("task.failed", { task: { id: recipeId, name }, run: { id: run.id, status: run.status, error: run.error, url: input.url }, diagnosis: run.diagnosis }, { refId: recipeId })
      .catch((e: Error) => log("warn", `Webhook failed: ${e.message}`));
  }

  if (okish && run.row_count && o.output.sheets.enabled && o.output.sheets.spreadsheet) {
    enqueue({ kind: "sheets", refId: run.id, title: `Sheets: ${name}`, trigger: "auto", input: { runId: run.id }, maxAttempts: 3 });
    log("info", "Queued the Google Sheets sync.");
  }

  // 3. Self-healing: the selectors broke, so prepare (or apply) a repair in the background.
  const reason = shouldHeal(task, {
    rows: run.row_count, okPages: okish ? 1 : 0, aiFallbackPages, validationFailed: validation?.status === "fail",
    belowRange: Boolean(expected && okish && run.row_count < expected.low),
  });
  if (reason && input.trigger !== "repair") {
    queueHeal(task, run.id, reason);
    log("info", `Queued an AI repair (${task.options.heal.mode === "auto" ? "applies itself if it passes the check" : "waits for your review"}).`);
  }
}
