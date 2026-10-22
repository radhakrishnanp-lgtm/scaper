import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultTaskOptions, type ExtractSpec, type FetchMode, type TaskOptions } from "@/lib/schemas";
import type { Cell, Dataset, PageLog, ScrapeResult } from "@/lib/types";
import { aiExtract, enrichRows } from "../ai/extract";
import { env } from "../env";
import { autoExtract } from "../extract/auto";
import { absolutize, load, readableText, safeSelect } from "../extract/dom";
import { extractWithSelectors } from "../extract/selectors";
import { serializeDataset } from "../export/formats";
import { fetchPage, FetchError } from "../fetcher";
import { emitWebhook } from "../integrations/webhooks";
import { deliver } from "../notify";
import { afterTaskRun } from "../ops/after-run";
import { diagnoseRun, expectedRange, type DiagnoseInput } from "../ops/diagnose";
import { isPrivate } from "../privacy";
import { newId } from "../repo/util";
import { saveMedia } from "../watch/visual";
import { runValidation, type ValidationReport } from "@/lib/validation";
import { audit } from "../repo/events";
import { lastGoodRun, markSeen, recentGoodCounts, saveRun, seenKeys, type RunStatus, type ScrapeRun } from "../repo/scrapes";
import { csvRecords, fillTemplate } from "@/lib/csv";
import type { BrowserStep } from "@/lib/schemas";
import { compilePatterns, matchesAny, normalizeForVisit, parseSitemap, parseUrlList } from "./urls";

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export type TaskRunInput = {
  url: string; mode: FetchMode; extract: ExtractSpec; options?: TaskOptions; screenshot?: boolean;
  recipeId?: string | null; taskName?: string; jobId?: string | null;
  /** The task's setup version this run uses, and what started it (manual, schedule, api, repair). */
  version?: number | null; trigger?: string;
};
export type RunHooks = {
  signal?: AbortSignal;
  log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  progress?: (p: { done?: number; total?: number; rows?: number; label?: string }) => void;
};

const FURNITURE = ["Links", "Images", "Headings"];
const MAX_PAGE_LOGS = 1000;

export function mainDatasetIndex(datasets: Dataset[]) {
  const i = datasets.findIndex((d) => !FURNITURE.includes(d.name));
  return i >= 0 ? i : 0;
}

/** Share of rows with a value per column, and what looks broken against the task's quality rules. */
export function qualityReport(ds: Dataset, rules: TaskOptions["quality"]) {
  const fill: Record<string, number> = {};
  for (const c of ds.columns) {
    const filled = ds.rows.filter((r) => r[c] !== null && r[c] !== undefined && r[c] !== "").length;
    fill[c] = ds.rows.length ? Math.round((filled / ds.rows.length) * 1000) / 10 : 0;
  }
  const issues: string[] = [];
  if (rules.minRows && ds.rows.length < rules.minRows) issues.push(`Only ${ds.rows.length} row(s); expected at least ${rules.minRows}.`);
  if (rules.minFillPercent && ds.rows.length) {
    for (const [c, pct] of Object.entries(fill)) {
      if (c.endsWith("_value") || c === "source_url" || c.startsWith("input_")) continue;
      if (pct < rules.minFillPercent) issues.push(`"${c}" is filled in only ${pct}% of rows (minimum ${rules.minFillPercent}%).`);
    }
  }
  return { fill, issues };
}

const withVars = (steps: BrowserStep[] | undefined, vars: Record<string, string> | undefined) =>
  !steps || !vars ? steps : steps.map((st) => (st.action === "type" ? { ...st, text: fillTemplate(st.text, vars) } : st.action === "select" ? { ...st, value: fillTemplate(st.value, vars) } : st));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task";

const isBlockedError = (e: unknown) => e instanceof FetchError && ["blocked", "robots", "paused"].includes(e.code);
const isCancelError = (e: unknown, signal?: AbortSignal) => signal?.aborted || (e instanceof FetchError && e.code === "cancelled");

/** Rows that are new or gone compared with the previous run, keyed by the chosen fields. */
export function compareRows(prev: Record<string, Cell>[], cur: Record<string, Cell>[], keyFields: string[], columns: string[]) {
  const keys = keyFields.length ? keyFields : columns.filter((c) => !c.endsWith("_value") && c !== "source_url");
  const keyOf = (r: Record<string, Cell>) => JSON.stringify(keys.map((k) => r[k] ?? null));
  const prevKeys = new Set(prev.map(keyOf));
  const curKeys = new Set(cur.map(keyOf));
  const added = cur.filter((r) => !prevKeys.has(keyOf(r)));
  const removed = prev.filter((r) => !curKeys.has(keyOf(r)));
  return { added, removed };
}

export function dedupeRows(rows: Record<string, Cell>[], fields: string[]) {
  if (!fields.length) return rows;
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = JSON.stringify(fields.map((f) => r[f] ?? null));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeInto(target: Map<string, Dataset>, datasets: Dataset[]) {
  for (const d of datasets) {
    const existing = target.get(d.name);
    if (!existing) { target.set(d.name, { name: d.name, columns: [...d.columns], rows: [...d.rows] }); continue; }
    for (const c of d.columns) if (!existing.columns.includes(c)) existing.columns.push(c);
    existing.rows.push(...d.rows);
  }
}

type PageExtract = { datasets: Dataset[]; meta: Record<string, unknown>; suggestions?: ScrapeResult["suggestions"]; notes: string[]; aiFallback?: boolean };

async function extractPage(html: string, url: string, extract: ExtractSpec, o: TaskOptions, signal?: AbortSignal): Promise<PageExtract> {
  if (extract.type === "auto") return { ...autoExtract(html, url), notes: [] };
  if (extract.type === "selectors") {
    const ds = extractWithSelectors(html, url, extract);
    // Self-healing read: when the selectors find nothing (the site changed its layout), the AI reads the page with the same column names.
    if (!ds.rows.length && o.aiFallback && extract.fields.length) {
      const r = await aiExtract(html, url, {
        type: "ai", scope: extract.itemSelector ? "list" : "single", input: "main", useFastModel: true,
        instruction: `Extract ${extract.itemSelector ? "every item" : "the values"} with these fields`,
        fields: extract.fields.map((f) => ({ name: f.name, type: f.attr === "href" ? "url" : f.attr === "src" ? "image" : f.transforms.some((t) => t.op === "number") ? "number" : "text", description: "" })),
      }, { signal });
      return { datasets: [{ ...r.dataset, name: ds.name }], meta: {}, notes: r.notes, aiFallback: true };
    }
    return { datasets: [ds], meta: {}, notes: [] };
  }
  const r = await aiExtract(html, url, extract, { signal });
  return { datasets: [r.dataset], meta: {}, notes: r.notes };
}

async function readSitemapUrls(o: TaskOptions["sitemap"], hooks: RunHooks): Promise<string[]> {
  const include = compilePatterns(o.include);
  const urls: string[] = [];
  const pending = [o.url];
  const seen = new Set<string>();
  while (pending.length && urls.length < o.limit && seen.size < 20) {
    const sm = pending.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    try {
      const page = await fetchPage(sm, "fast", { signal: hooks.signal, accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" });
      const parsed = parseSitemap(page.html);
      pending.push(...parsed.sitemaps);
      for (const u of parsed.urls) if (matchesAny(u, include, true) && urls.length < o.limit) urls.push(u);
      hooks.log?.("info", `Sitemap ${sm}: ${parsed.urls.length} URLs, ${parsed.sitemaps.length} nested sitemaps.`);
    } catch (e) {
      hooks.log?.("warn", `Could not read sitemap ${sm}: ${errorMessage(e)}`);
    }
  }
  return urls;
}

/**
 * Runs a scrape task: one page, a list of URLs, a sitemap, paginated listings,
 * list → detail pages, or a small crawl, all through the same polite fetcher.
 * Saves the run in history (even when cancelled or partly failed) and returns it.
 */
export async function runTask(input: TaskRunInput, hooks: RunHooks = {}): Promise<ScrapeRun> {
  const o = input.options ?? defaultTaskOptions();
  const started = Date.now();
  const log = hooks.log ?? (() => undefined);
  const browser = input.mode === "browser";
  const pagination = o.pagination;
  const browserPagination = browser && ["click", "scroll", "loadMore"].includes(pagination.type) ? pagination : undefined;
  if (!browser && ["click", "scroll", "loadMore"].includes(pagination.type)) log("warn", "This pagination type needs Browser mode, so it was skipped.");

  // CSV inputs: one start URL per row, with {{column}} filled in (URL-encoded).
  const inputs = o.inputs.trim() ? csvRecords(o.inputs) : [];
  type QueueItem = { url: string; depth: number; pageNo: number; vars?: Record<string, string>; category?: string };
  let queue: QueueItem[];
  if (o.categories.length) {
    // Category scrape: read each category page (with its own pagination) instead of the start URL.
    queue = o.categories.flatMap((c) => parseUrlList([c.url]).map((url) => ({ url, depth: 0, pageNo: 1, category: c.name })));
  } else if (inputs.length) {
    queue = inputs.flatMap((vars) => parseUrlList([fillTemplate(input.url, vars, true), ...o.startUrls.map((u) => fillTemplate(u, vars, true))]).map((url) => ({ url, depth: 0, pageNo: 1, vars })));
  } else {
    queue = parseUrlList([input.url, ...o.startUrls]).map((url) => ({ url, depth: 0, pageNo: 1 }));
  }
  if (o.sitemap.url) queue.push(...(await readSitemapUrls(o.sitemap, hooks)).map((url) => ({ url, depth: 0, pageNo: 1 })));
  const starts = queue;
  const incremental = Boolean(o.incremental && input.recipeId);
  const newlySeen: string[] = [];
  const visited = new Set<string>();
  const include = compilePatterns(o.crawl.include);
  const exclude = compilePatterns(o.crawl.exclude);
  const pages: PageLog[] = [];
  const merged = new Map<string, Dataset>();
  const notes: string[] = [];
  let first: Pick<ScrapeResult, "title" | "finalUrl" | "meta" | "suggestions" | "screenshot"> | null = null;
  let firstError: string | null = null;
  let firstErr: DiagnoseInput["error"] = null;
  let evidence: string | null = null;
  let firstHtml: string | null = null;
  let firstText: string | null = null;
  let blocked = false;
  let cancelled = false;
  let fetched = 0;
  let okPages = 0;
  let aiFallbackPages = 0;
  const mainRows = () => [...merged.values()][mainDatasetIndex([...merged.values()])]?.rows.length ?? 0;

  log("info", `Starting with ${starts.length} URL(s), up to ${o.limits.maxPages} page(s).`);
  while (queue.length && fetched < o.limits.maxPages && mainRows() < o.limits.maxRows) {
    if (hooks.signal?.aborted) { cancelled = true; break; }
    const item = queue.shift()!;
    const key = normalizeForVisit(item.url);
    if (visited.has(key)) continue;
    visited.add(key);
    fetched++;
    const t0 = Date.now();
    hooks.progress?.({ done: fetched - 1, total: Math.min(o.limits.maxPages, fetched + queue.length), rows: mainRows(), label: item.url });
    try {
      const page = await fetchPage(item.url, input.mode, {
        screenshot: !first && input.screenshot,
        // A screenshot of the first page, kept only if the run needs a failure report.
        evidence: browser && !first && !evidence,
        scroll: browser && (pagination.type === "none" || pagination.type === "next"),
        steps: browser ? withVars(o.steps, item.vars) : undefined,
        pagination: item.depth === 0 ? browserPagination : undefined,
        signal: hooks.signal,
      });
      notes.push(...page.notes.filter((n) => !notes.includes(n)));
      const htmls = page.pages?.length ? page.pages : [page.html];
      const pageSets: Dataset[] = [];
      let meta = {};
      let suggestions: ScrapeResult["suggestions"];
      for (const [i, html] of htmls.entries()) {
        const ex = await extractPage(html, page.finalUrl, input.extract, o, hooks.signal);
        if (i === 0) { meta = ex.meta; suggestions = ex.suggestions; }
        for (const n of ex.notes) if (!notes.includes(n) && notes.length < 40) notes.push(n);
        if (ex.aiFallback) {
          aiFallbackPages++;
          log("warn", `Selectors found nothing on ${page.finalUrl}; the AI read the page instead.`);
        }
        for (const d of ex.datasets) {
          const existing = pageSets.find((p) => p.name === d.name);
          if (existing) { existing.rows.push(...d.rows); for (const c of d.columns) if (!existing.columns.includes(c)) existing.columns.push(c); }
          else pageSets.push({ ...d, columns: [...d.columns], rows: [...d.rows] });
        }
      }
      const mainSet = pageSets[mainDatasetIndex(pageSets)];
      if (mainSet && o.includeSourceUrl) {
        for (const r of mainSet.rows) r.source_url = page.finalUrl;
        if (!mainSet.columns.includes("source_url")) mainSet.columns.push("source_url");
      }
      if (mainSet && item.category) {
        for (const r of mainSet.rows) r.category = item.category;
        if (!mainSet.columns.includes("category")) mainSet.columns.unshift("category");
      }
      if (mainSet && item.vars) {
        for (const [k, v] of Object.entries(item.vars)) {
          const col = `input_${k}`;
          for (const r of mainSet.rows) r[col] = v;
          if (!mainSet.columns.includes(col)) mainSet.columns.push(col);
        }
      }
      // Incremental: drop items whose detail page an earlier run already scraped.
      if (mainSet && incremental && o.detail.enabled) {
        const keyOf = (r: Record<string, Cell>) => (typeof r[o.detail.linkField] === "string" ? normalizeForVisit(absolutize(r[o.detail.linkField] as string, page.finalUrl) ?? "") : "");
        const seen = seenKeys(input.recipeId!, mainSet.rows.map(keyOf).filter(Boolean));
        const before = mainSet.rows.length;
        mainSet.rows = mainSet.rows.filter((r) => !seen.has(keyOf(r)));
        if (before !== mainSet.rows.length) log("info", `Skipped ${before - mainSet.rows.length} item(s) already scraped in earlier runs.`);
      }

      // List → detail: open each item's link and add the detail fields to its row.
      if (mainSet && o.detail.enabled && o.detail.fields.length) {
        for (const row of mainSet.rows) {
          if (hooks.signal?.aborted || fetched >= o.limits.maxPages) break;
          const link = typeof row[o.detail.linkField] === "string" ? absolutize(row[o.detail.linkField] as string, page.finalUrl) : null;
          if (!link || visited.has(normalizeForVisit(link))) continue;
          visited.add(normalizeForVisit(link));
          fetched++;
          const d0 = Date.now();
          try {
            const detail = await fetchPage(link, input.mode, { steps: browser ? o.steps : undefined, signal: hooks.signal });
            const extra = extractWithSelectors(detail.html, detail.finalUrl, { itemSelector: "", fields: o.detail.fields }).rows[0] ?? {};
            Object.assign(row, extra);
            for (const c of Object.keys(extra)) if (!mainSet.columns.includes(c)) mainSet.columns.push(c);
            if (incremental) newlySeen.push(normalizeForVisit(link));
            okPages++;
            if (pages.length < MAX_PAGE_LOGS) pages.push({ url: link, status: "ok", rows: 1, ms: Date.now() - d0, depth: item.depth + 1 });
          } catch (e) {
            if (isCancelError(e, hooks.signal)) { cancelled = true; break; }
            if (pages.length < MAX_PAGE_LOGS) pages.push({ url: link, status: isBlockedError(e) ? "blocked" : "error", rows: 0, ms: Date.now() - d0, depth: item.depth + 1, error: errorMessage(e) });
            log("warn", `Detail page failed: ${link}: ${errorMessage(e)}`);
            if (isBlockedError(e)) { blocked = true; break; }
          }
          hooks.progress?.({ done: fetched, total: Math.min(o.limits.maxPages, fetched + queue.length), rows: mainRows() + mainSet.rows.length, label: link });
        }
      }
      mergeInto(merged, pageSets);
      if (!first) {
        first = { title: page.title, finalUrl: page.finalUrl, meta, suggestions, screenshot: input.screenshot ? page.screenshot : undefined };
        if (browser && page.screenshot) evidence = page.screenshot;
        firstHtml = htmls[0] ?? null;
        firstText = page.text ?? null;
      }
      okPages++;

      // Pagination by following the "next" link.
      if (pagination.type === "next" && item.pageNo < pagination.maxPages) {
        const $ = load(htmls[htmls.length - 1]!);
        const next = absolutize(safeSelect($, pagination.selector).first().attr("href"), page.finalUrl);
        if (next && !visited.has(normalizeForVisit(next))) queue.unshift({ url: next, depth: item.depth, pageNo: item.pageNo + 1, vars: item.vars, category: item.category });
      }
      // Crawl: queue matching links one level deeper.
      if (o.crawl.enabled && item.depth < o.crawl.maxDepth) {
        const $ = load(htmls[0]!);
        const host = new URL(page.finalUrl).hostname;
        let added = 0;
        safeSelect($, o.crawl.linkSelector || "a[href]").each((_, el) => {
          const href = absolutize($(el).attr("href"), page.finalUrl);
          if (!href || !/^https?:/i.test(href)) return;
          if (o.crawl.sameHost && new URL(href).hostname !== host) return;
          if (!matchesAny(href, include, true) || matchesAny(href, exclude, false)) return;
          if (visited.has(normalizeForVisit(href)) || queue.some((q) => q.url === href)) return;
          queue.push({ url: href, depth: item.depth + 1, pageNo: 1 });
          added++;
        });
        if (added) log("info", `Queued ${added} link(s) from ${page.finalUrl}.`);
      }
      const rows = mainSet?.rows.length ?? 0;
      if (pages.length < MAX_PAGE_LOGS) pages.push({ url: page.finalUrl, status: "ok", rows, ms: Date.now() - t0, depth: item.depth });
      log("info", `Page ${fetched}: ${rows} row(s) from ${page.finalUrl} (${Date.now() - t0} ms).`);
    } catch (e) {
      if (isCancelError(e, hooks.signal)) { cancelled = true; break; }
      const msg = errorMessage(e);
      firstError ??= msg;
      firstErr ??= { code: e instanceof FetchError ? e.code : "unknown", status: e instanceof FetchError ? e.status ?? null : null, message: msg, url: item.url };
      if (e instanceof FetchError && e.evidence && !evidence) evidence = e.evidence;
      if (pages.length < MAX_PAGE_LOGS) pages.push({ url: item.url, status: isBlockedError(e) ? "blocked" : "error", rows: 0, ms: Date.now() - t0, depth: item.depth, error: msg });
      log(isBlockedError(e) ? "warn" : "error", `Page ${fetched} failed: ${item.url}: ${msg}`);
      // A bot check or robots refusal means "stop", not "try the next page".
      if (isBlockedError(e)) { blocked = true; break; }
    }
  }
  if (queue.length && fetched >= o.limits.maxPages) notes.push(`Stopped at the page limit (${o.limits.maxPages}). Raise it in the task's Limits to read more.`);

  // Finish datasets: furniture deduped, main dataset deduped and capped.
  const datasets = [...merged.values()];
  const mi = mainDatasetIndex(datasets);
  datasets.forEach((d, i) => {
    if (i === mi) {
      d.rows = dedupeRows(d.rows, o.dedupeBy).slice(0, o.limits.maxRows);
    } else if (FURNITURE.includes(d.name)) {
      d.rows = dedupeRows(d.rows, d.columns).slice(0, 2000);
    }
  });
  const main = datasets[mi];
  const rowCount = main?.rows.length ?? 0;
  if (aiFallbackPages) notes.push(`The selectors found nothing on ${aiFallbackPages} page(s), so your AI read them instead. Use "Fix with AI" on the task to update the selectors.`);
  if (main && rowCount && o.aiColumns.length && !cancelled) {
    log("info", `Filling ${o.aiColumns.length} AI column(s) for up to ${Math.min(rowCount, o.aiColumnsMaxRows)} row(s).`);
    hooks.progress?.({ done: fetched, total: fetched, rows: rowCount, label: "Filling AI columns" });
    await enrichRows(main, o.aiColumns, o.aiColumnsMaxRows, { signal: hooks.signal, log: (l, m) => log(l, m) });
  }
  if (incremental && newlySeen.length && !cancelled) markSeen(input.recipeId!, newlySeen);
  if (main && input.extract.type === "selectors" && !rowCount && okPages) {
    notes.push("No elements matched. Try Auto mode to see suggested selectors, or Browser mode if the page builds its content with JavaScript.");
  }

  let status: RunStatus;
  if (cancelled) status = "cancelled";
  else if (!okPages) status = blocked ? "blocked" : "error";
  else if (pages.some((p) => p.status === "error" || p.status === "blocked")) status = "partial";
  else status = "ok";

  const result: ScrapeResult | null = okPages || rowCount
    ? { title: first?.title ?? "", finalUrl: first?.finalUrl ?? input.url, datasets, meta: first?.meta ?? {}, notes, screenshot: first?.screenshot, suggestions: first?.suggestions, pages: fetched > 1 ? pages : undefined }
    : null;

  if (result && main && okPages) {
    result.quality = qualityReport(main, o.quality);
    if (result.quality.issues.length) {
      log("warn", `Data quality: ${result.quality.issues.join(" ")}`);
      if (o.quality.alert && input.recipeId) {
        await deliver({ kind: "task", title: `${input.taskName ?? "Task"}: data looks broken`, body: `${result.quality.issues.join("\n")}\nA selector may have stopped matching after a site change.`, url: input.url, data: { recipeId: input.recipeId } }, o.monitor.channels);
      }
    }
  }

  // Validation rules and the usual row range (from recent good runs).
  let validation: ValidationReport | null = null;
  if (result && main && okPages && o.validation.rules.some((r) => r.enabled)) {
    validation = runValidation(main, o.validation.rules);
    result.validation = validation;
    log(validation.status === "fail" ? "warn" : "info", `Data checks: ${validation.counts.pass} passed, ${validation.counts.warn} warning(s), ${validation.counts.fail} failed (score ${validation.score ?? "—"}).`);
  }
  const expected = input.recipeId && !isPrivate() ? expectedRange(recentGoodCounts(input.recipeId)) : null;
  if (result) result.expected = expected;

  // What's new since the previous run of this task.
  if (result && main && input.recipeId && o.monitor.enabled && (status === "ok" || status === "partial")) {
    const prev = lastGoodRun(input.recipeId);
    const prevMain = prev?.result?.datasets[mainDatasetIndex(prev.result.datasets)];
    if (prevMain) {
      const diff = compareRows(prevMain.rows, main.rows, o.monitor.keyFields, main.columns);
      result.monitor = { added: diff.added.length, removed: diff.removed.length, addedRows: diff.added.slice(0, 50), removedRows: diff.removed.slice(0, 50) };
      log("info", `Compared with the previous run: ${diff.added.length} new, ${diff.removed.length} removed.`);
      const lines: string[] = [];
      if (o.monitor.notifyNew && diff.added.length) lines.push(`${diff.added.length} new row(s)`, ...diff.added.slice(0, 5).map((r) => `+ ${preview(r, main.columns)}`));
      if (o.monitor.notifyRemoved && diff.removed.length) lines.push(`${diff.removed.length} removed row(s)`, ...diff.removed.slice(0, 5).map((r) => `- ${preview(r, main.columns)}`));
      if (lines.length) {
        await deliver({ kind: "task", title: `${input.taskName ?? "Task"}: ${lines[0]}`, body: lines.slice(1).join("\n") || lines[0]!, url: input.url, data: { recipeId: input.recipeId, added: diff.added.length, removed: diff.removed.length } }, o.monitor.channels);
      }
    } else {
      log("info", "First run with change tracking: saved as the baseline.");
    }
  }

  // Files and webhook.
  if (result && main && rowCount && o.output.files.length) {
    const dir = path.join(env.dataDir, "exports", slug(input.taskName ?? new URL(input.url).hostname));
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    result.files = [];
    for (const f of o.output.files) {
      const out = serializeDataset(main, f);
      const file = path.join(dir, `${stamp}.${out.ext}`);
      await fs.writeFile(file, out.body);
      result.files.push(path.relative(env.dataDir, file));
    }
    log("info", `Saved ${result.files.join(", ")}.`);
  }

  // Failure report: cause, evidence and the next step.
  const failedPages = pages.filter((p) => p.status === "error" || p.status === "blocked").length;
  const diagnosis = diagnoseRun({
    status, mode: input.mode, extractType: input.extract.type, rows: rowCount, okPages, failedPages, fetched, error: firstErr,
    hasSteps: o.steps.length > 0, aiFallbackPages, validation, expected, url: input.url,
    firstHtml, firstText: firstText ?? (firstHtml && !rowCount ? readableText(load(firstHtml)) : null),
  });
  if (diagnosis) {
    if (evidence && !isPrivate()) diagnosis.screenshot = await saveMedia(`runs/${newId()}.jpg`, Buffer.from(evidence, "base64")).catch(() => null);
    if (result) result.diagnosis = diagnosis;
    log(diagnosis.severity === "error" ? "warn" : "info", `Diagnosis: ${diagnosis.title}.`);
  }

  const run = saveRun({
    recipe_id: input.recipeId ?? null, job_id: input.jobId ?? null, url: input.url, final_url: first?.finalUrl ?? null, mode: input.mode, status,
    extract: input.extract, result, row_count: rowCount, page_count: fetched, error: status === "ok" ? null : cancelled ? "Cancelled." : firstError,
    duration_ms: Date.now() - started, version: input.version ?? null, diagnosis, score: validation?.score ?? null,
    validation: validation ? { status: validation.status, score: validation.score, failed: validation.counts.fail, warned: validation.counts.warn } : null,
  });

  if (input.recipeId && !isPrivate()) {
    await afterTaskRun({ run, input, options: o, validation, expected, aiFallbackPages, log }).catch((e: Error) => log("warn", `Health checks failed: ${e.message}`));
  }

  if (o.output.webhook && result && main) {
    await emitWebhook("task.finished", {
      task: { id: input.recipeId ?? null, name: input.taskName ?? null },
      run: { id: run.id, status, rows: rowCount, pages: fetched, url: input.url, score: run.score ?? null }, columns: main.columns, rows: main.rows.slice(0, 500),
      monitor: result.monitor ? { added: result.monitor.added, removed: result.monitor.removed } : null,
      validation: result.validation ? { status: result.validation.status, score: result.validation.score } : null,
    }, { refId: input.recipeId ?? null }).then((rs) => {
      for (const r of rs) log(r.ok ? "info" : "warn", r.ok ? `Sent the webhook to ${r.target}.` : `Webhook to ${r.target} failed: ${r.error}${r.retrying ? " (will retry)" : ""}`);
    }).catch((e: Error) => log("warn", `Webhook failed: ${e.message}`));
  }

  hooks.progress?.({ done: fetched, total: fetched, rows: rowCount, label: "Finished" });
  audit(status === "ok" || status === "partial" ? "scrape.ok" : "scrape.failed", {
    runId: run.id, host: new URL(input.url).hostname, rows: rowCount, pages: fetched, status, type: input.extract.type,
  }, status === "ok" || status === "partial" ? "info" : "warn");
  return run;
}

function preview(r: Record<string, Cell>, columns: string[]) {
  return columns.filter((c) => !c.endsWith("_value")).slice(0, 3).map((c) => r[c]).filter((v) => v !== null && v !== "").join(" · ").slice(0, 160);
}

/** One-page scrape with default options (the quick Scrape page and the agent). */
export function runScrape(input: { url: string; mode: FetchMode; extract: ExtractSpec; screenshot?: boolean; recipeId?: string | null }, hooks?: RunHooks) {
  return runTask(input, hooks);
}
