import "server-only";
import { z } from "zod";
import {
  aiFieldSchema, conditionSchema, dealFiltersSchema, dealSearchSchema, defaultTaskOptions, taskSchema, urlSchema, watcherSchema,
} from "@/lib/schemas";
import { trackProduct, scanListing, withStats } from "../deals/tracker";
import { canonicalProductUrl } from "../deals/parsers";
import { autoExtract } from "../extract/auto";
import { extractWithSelectors } from "../extract/selectors";
import { fetchPage } from "../fetcher";
import { parseSitemap } from "../tasks/urls";
import { compareRows, mainDatasetIndex } from "../tasks/engine";
import { deliver } from "../notify";
import { enqueueAndWait } from "../jobs";
import { addMemory, deleteMemory, listMemory } from "../repo/ai";
import { aiCostThisMonth, aiUsageToday } from "../repo/agent";
import { createDealSearch, listDealSearches } from "../repo/deal-searches";
import { audit } from "../repo/events";
import { deleteProduct, getProductByUrl, listProducts } from "../repo/products";
import { createRecipe, deleteRecipe, getRecipe, getRun, listRecipes, listRuns, setRecipeSchedulePaused, updateRecipe, validateCron, type Recipe } from "../repo/scrapes";
import { getSiteRule, hostSummaries, upsertSiteRule } from "../repo/sites";
import { changesSince, createWatcher, deleteWatcher, getWatcher, listWatchers, setWatcherEnabled, type Watcher } from "../repo/watchers";
import { getSettings } from "../repo/settings";
import type { AgentBrowser } from "./browser-session";
import { type ModelChoice, type ToolDef } from "./client";
import { buildPageContext, linkLines } from "./context";
import { planCategoryScrape } from "./crawl";
import { aiExtract } from "./extract";
import { suggestSelectors } from "./suggest";

/**
 * Everything the agent can do, as tools. Tools marked `changes` create, edit or delete your saved things
 * or send messages; in "ask first" mode the agent pauses on each of them until you allow it.
 */

export type ToolContext = { browser: AgentBrowser; signal: AbortSignal; model: ModelChoice };
export type AgentTool = {
  group: "Read the web" | "Browser" | "Tasks & data" | "Watchers" | "Prices & deals" | "Scaper";
  changes: boolean;
  def: ToolDef;
  /** One line for the approval card: what exactly will happen. */
  describe?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

const MAX_RESULT = 9000;
export const clip = (s: string, max = MAX_RESULT) => (s.length > max ? s.slice(0, max) + "\n[truncated]" : s);
const j = (v: unknown) => clip(JSON.stringify(v));
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const urlArg = (a: Record<string, unknown>) => urlSchema.parse(a.url);
const short = (s: unknown, n = 60) => String(s ?? "").slice(0, n);

function findTask(key: unknown): Recipe {
  const k = String(key ?? "").trim();
  const t = getRecipe(k) ?? listRecipes().find((r) => r.name.toLowerCase() === k.toLowerCase());
  if (!t) throw new Error(`No task called "${k}". Use list_tasks to see the names.`);
  return t;
}
function findWatcher(key: unknown): Watcher {
  const k = String(key ?? "").trim();
  const w = getWatcher(k) ?? listWatchers().find((x) => x.name.toLowerCase() === k.toLowerCase());
  if (!w) throw new Error(`No watcher called "${k}". Use list_watchers to see the names.`);
  return w;
}
const schedule = (t: Recipe) => t.cron ?? (t.schedule_minutes ? `every ${t.schedule_minutes} min` : "manual");

const extractArg = {
  type: "object",
  description: 'How to read the data. {"type":"auto"} finds lists by itself; {"type":"ai","instruction":"...","fields":[{"name":"...","type":"text|number|url|image|boolean|date|list"}]} lets the AI read each page; {"type":"selectors","itemSelector":"...","fields":[{"name":"...","selector":"...","attr":"text|href|src"}]} uses CSS selectors (get them from suggest_selectors).',
};

export const TOOLS: Record<string, AgentTool> = {
  // Read the web
  read_page: {
    group: "Read the web", changes: false,
    def: def("read_page", "Load a page and read it as Markdown with numbered links ([text][n]) and its structured data. Use focus=full to include menus and footers (for finding categories).", {
      url: str("Absolute http(s) URL"), fast: bool("true = plain HTTP without JavaScript (faster). Default false."), focus: { type: "string", enum: ["main", "full"], description: "main (default) or full" },
    }, ["url"]),
    run: async (a, ctx) => {
      const page = await fetchPage(urlArg(a), a.fast ? "fast" : "browser", { signal: ctx.signal });
      const c = buildPageContext(page.html, page.finalUrl, { scope: a.focus === "full" ? "full" : "main", budgetTokens: 5500 });
      return clip(`URL: ${page.finalUrl}\nTitle: ${c.title}\n${c.description ? `Description: ${c.description}\n` : ""}<page>\n${c.markdown}\n\nLinks:\n${linkLines(c.links, page.finalUrl, 80)}${c.structured ? `\n\nStructured data:\n${c.structured.slice(0, 1500)}` : ""}\n</page>`, 24_000);
    },
  },
  extract_items: {
    group: "Read the web", changes: false,
    def: def("extract_items", "Load a page and automatically find lists of items (products, results, posts), structured product data and tables. Fast and free (no AI tokens).", { url: str("Absolute URL") }, ["url"]),
    run: async (a, ctx) => {
      const page = await fetchPage(urlArg(a), "browser", { scroll: true, signal: ctx.signal });
      const { datasets, meta } = autoExtract(page.html, page.finalUrl);
      const useful = datasets.filter((d) => !["Links", "Images", "Headings"].includes(d.name)).slice(0, 3).map((d) => ({ name: d.name, rows: d.rows.slice(0, 25) }));
      return j({ title: page.title, meta, datasets: useful });
    },
  },
  extract_with_ai: {
    group: "Read the web", changes: false,
    def: def("extract_with_ai", "Load a page and have the AI pull out exactly the fields you name, as rows. Works on messy pages; values are checked against the page text.", {
      url: str("Absolute URL"), instruction: str("What to extract, e.g. 'every laptop with name, price, rating and link'"),
      fields: { type: "array", items: { type: "object", properties: { name: str("snake_case column"), type: { type: "string", enum: ["text", "number", "url", "image", "boolean", "date", "list"] }, description: str("what goes in it") }, required: ["name"] } },
      single: bool("true when the page is about one thing (one row)"),
    }, ["url", "instruction"]),
    run: async (a, ctx) => {
      const fields = z.array(aiFieldSchema).max(30).parse(a.fields ?? []);
      const page = await fetchPage(urlArg(a), "browser", { signal: ctx.signal });
      const r = await aiExtract(page.html, page.finalUrl, { type: "ai", instruction: String(a.instruction ?? "").slice(0, 1000) || "Extract the main data", fields, scope: a.single ? "single" : "list", input: "main", useFastModel: true }, { signal: ctx.signal });
      return j({ rows: r.dataset.rows.slice(0, 40), total: r.dataset.rows.length, columns: r.dataset.columns, notes: r.notes });
    },
  },
  extract_with_selectors: {
    group: "Read the web", changes: false,
    def: def("extract_with_selectors", "Load a page and extract fields with CSS selectors. Use when you know the page structure (see suggest_selectors).", {
      url: str("Absolute URL"), item_selector: str("CSS selector for each repeated item, or empty for the whole page"),
      fields: { type: "array", items: { type: "object", properties: { name: str("column name"), selector: str("CSS selector relative to the item"), attr: str("text, html, or an attribute like href") }, required: ["name", "selector"] } },
    }, ["url", "fields"]),
    run: async (a, ctx) => {
      const fields = z.array(z.object({ name: z.string().min(1).max(60), selector: z.string().min(1).max(500), attr: z.string().max(60).default("text") })).min(1).max(20).parse(a.fields).map((f) => ({ ...f, multiple: false }));
      const page = await fetchPage(urlArg(a), "browser", { signal: ctx.signal });
      const ds = extractWithSelectors(page.html, page.finalUrl, { itemSelector: String(a.item_selector ?? ""), fields });
      return j({ count: ds.rows.length, rows: ds.rows.slice(0, 40) });
    },
  },
  suggest_selectors: {
    group: "Read the web", changes: false,
    def: def("suggest_selectors", "Work out CSS selectors for the data described (an item selector plus fields), tested on the page. Good before create_task, because selectors are fast and free to run on a schedule.", {
      url: str("Absolute URL"), describe: str("What to extract, e.g. 'name, price and link of each product'"),
    }, ["url", "describe"]),
    run: async (a, ctx) => {
      const page = await fetchPage(urlArg(a), "browser", { signal: ctx.signal });
      const r = await suggestSelectors(page.html, page.finalUrl, String(a.describe ?? "").slice(0, 500), "fast");
      return j({ item_selector: r.itemSelector, fields: r.fields, matched_rows: r.count, sample: r.rows.slice(0, 5), note: r.note });
    },
  },
  map_site: {
    group: "Read the web", changes: false,
    def: def("map_site", "List a site's pages: URLs from its sitemap plus the menu links of the given page, grouped by section. Use to find category or listing pages.", { url: str("Any page of the site, usually the home page"), limit: num("Max sitemap URLs, default 200") }, ["url"]),
    run: async (a, ctx) => {
      const url = urlArg(a);
      const origin = new URL(url).origin;
      const out: { sitemap: string[]; sections: Record<string, { text: string; url: string }[]>; notes: string[] } = { sitemap: [], sections: {}, notes: [] };
      const limit = Math.min(1000, Math.max(10, Number(a.limit ?? 200)));
      try {
        const robots = await fetchPage(`${origin}/robots.txt`, "fast", { signal: ctx.signal, accept: "text/plain" });
        const maps = [...robots.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!).slice(0, 3);
        for (const sm of maps.length ? maps : [`${origin}/sitemap.xml`]) {
          if (out.sitemap.length >= limit) break;
          try {
            const p = parseSitemap((await fetchPage(sm, "fast", { signal: ctx.signal, accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" })).html);
            out.sitemap.push(...p.urls.slice(0, limit - out.sitemap.length));
            if (!p.urls.length && p.sitemaps.length) out.notes.push(`Sitemap index with ${p.sitemaps.length} sitemaps: ${p.sitemaps.slice(0, 8).join(", ")}`);
          } catch (e) { out.notes.push(`Sitemap ${sm}: ${(e as Error).message}`); }
        }
      } catch (e) { out.notes.push(`robots.txt: ${(e as Error).message}`); }
      const page = await fetchPage(url, "browser", { signal: ctx.signal });
      const ctxPage = buildPageContext(page.html, page.finalUrl, { scope: "full", maxLinks: 600 });
      for (const l of ctxPage.links) {
        if (l.image || !l.href.startsWith(origin) || !l.text) continue;
        const section = new URL(l.href).pathname.split("/").filter(Boolean)[0] ?? "/";
        const list = (out.sections[section] ??= []);
        if (list.length < 15) list.push({ text: l.text.slice(0, 60), url: l.href });
      }
      return j(out);
    },
  },
  plan_category_scrape: {
    group: "Read the web", changes: false,
    def: def("plan_category_scrape", "Plan scraping a whole site by category: picks the category pages for the goal, works out item selectors on one of them and finds the next-page link. Returns a plan you can pass to create_task (categories, extract, pagination).", {
      url: str("Start page, usually the home page"), goal: str("What to collect, e.g. 'all laptops with price and rating'"),
      max_categories: num("Default 8, max 30"), pages_per_category: num("Default 3"),
    }, ["url", "goal"]),
    run: async (a, ctx) => {
      const plan = await planCategoryScrape({ url: urlArg(a), goal: String(a.goal ?? "").slice(0, 500), mode: "browser", maxCategories: Math.min(30, Math.max(1, Number(a.max_categories ?? 8))), pagesPerCategory: Math.min(50, Math.max(1, Number(a.pages_per_category ?? 3))), model: ctx.model, signal: ctx.signal });
      return j({
        start_url: plan.startUrl, categories: plan.categories.map((c) => ({ name: c.name, url: c.url })),
        extract: plan.sample.count ? { type: "selectors", itemSelector: plan.sample.itemSelector, fields: plan.sample.fields } : { type: "ai", instruction: plan.goal, fields: [] },
        pagination: plan.pagination, sample_rows: plan.sample.rows.slice(0, 5), matched_on_first_category: plan.sample.count, notes: plan.notes,
      });
    },
  },

  // Browser
  browser_open: {
    group: "Browser", changes: false,
    def: def("browser_open", "Open a page in your own browser tab (kept for this conversation) and list its links, buttons and fields by number. Use it for sites where you must click, search or choose options.", { url: str("Absolute URL") }, ["url"]),
    run: async (a, ctx) => clip(await ctx.browser.open(urlArg(a)), 14_000),
  },
  browser_act: {
    group: "Browser", changes: false,
    def: def("browser_act", "Do one thing in your browser tab: click an element, type into a field, submit (type and press Enter), select an option, scroll, or go back. Returns the updated element list.", {
      action: { type: "string", enum: ["click", "type", "submit", "select", "scroll", "back"] },
      element: num("Element number from the latest list (not needed for scroll or back)"),
      text: str("Text to type, option to select, or 'up'/'down' for scroll"),
    }, ["action"]),
    run: async (a, ctx) => clip(await ctx.browser.act(String(a.action), a.element ? Number(a.element) : undefined, a.text === undefined ? undefined : String(a.text)), 14_000),
  },
  browser_read: {
    group: "Browser", changes: false,
    def: def("browser_read", "Read the page currently open in your browser tab as Markdown with numbered links.", {}),
    run: async (_a, ctx) => clip(await ctx.browser.read(), 24_000),
  },
  browser_extract: {
    group: "Browser", changes: false,
    def: def("browser_extract", "Have the AI extract rows from the page currently open in your browser tab (after clicking filters, searching, and so on).", {
      instruction: str("What to extract"),
      fields: { type: "array", items: { type: "object", properties: { name: str("snake_case column"), type: { type: "string", enum: ["text", "number", "url", "image", "boolean", "date", "list"] } }, required: ["name"] } },
    }, ["instruction"]),
    run: async (a, ctx) => {
      const { html, url } = await ctx.browser.html();
      const fields = z.array(aiFieldSchema).max(30).parse(a.fields ?? []);
      const r = await aiExtract(html, url, { type: "ai", instruction: String(a.instruction ?? "").slice(0, 1000), fields, scope: "list", input: "main", useFastModel: true }, { signal: ctx.signal });
      return j({ url, rows: r.dataset.rows.slice(0, 40), total: r.dataset.rows.length, notes: r.notes });
    },
  },

  // Tasks & data
  list_tasks: {
    group: "Tasks & data", changes: false,
    def: def("list_tasks", "List the user's saved scraping tasks with schedule and last run.", {}),
    run: async () => j(listRecipes().slice(0, 60).map((t) => ({ id: t.id, name: t.name, url: t.url, extract: t.extract.type, categories: t.options.categories.length || undefined, schedule: schedule(t), paused: (t.schedule_minutes || t.cron) && !t.next_run_at ? true : undefined, last_run: t.last_run_at, last_status: t.last_status }))),
  },
  run_task: {
    group: "Tasks & data", changes: false,
    def: def("run_task", "Run one of the user's saved tasks now and return a summary of the rows. Only when the user asks to run it.", { task: str("Task id or exact name") }, ["task"]),
    run: async (a) => {
      const task = findTask(a.task);
      const job = await enqueueAndWait({ kind: "task", refId: task.id, title: `Task: ${task.name}`, trigger: "agent", input: { taskId: task.id }, unique: true }, 240_000);
      const runId = (job.result as { runId?: string } | null)?.runId;
      const run = runId ? getRun(runId) : null;
      const ds = run?.result?.datasets?.[mainDatasetIndex(run.result.datasets)];
      return j({ status: job.status, error: job.error, run_id: runId ?? null, rows: ds?.rows.length ?? 0, columns: ds?.columns ?? [], sample: ds?.rows.slice(0, 15) ?? [] });
    },
  },
  create_task: {
    group: "Tasks & data", changes: true,
    describe: (a) => `Save a task "${short(a.name)}" for ${short(a.url, 80)}${a.schedule_minutes ? `, running every ${a.schedule_minutes} min` : a.cron ? ` on "${a.cron}"` : ""}${Array.isArray(a.categories) && a.categories.length ? ` across ${a.categories.length} categories` : ""}.`,
    def: def("create_task", "Save a scraping task the user can run again or on a schedule. Only when the user asks to save, schedule or keep scraping something.", {
      name: str("Short name"), url: str("Start URL"), mode: { type: "string", enum: ["browser", "fast"] }, extract: extractArg,
      categories: { type: "array", description: "Category pages to read instead of the start URL (from plan_category_scrape)", items: { type: "object", properties: { name: str("Category"), url: str("URL") }, required: ["name", "url"] } },
      pagination: { type: "object", description: '{"type":"next","selector":"a.next","maxPages":5} or {"type":"none"}' },
      schedule_minutes: num("Run every N minutes (15 or more). Leave out for manual."), cron: str("Or a cron schedule like '0 9 * * *'"),
      ai_fallback: bool("Let the AI read pages where the selectors find nothing (default true)"),
    }, ["name", "url", "extract"]),
    run: async (a) => {
      validateCron(a.cron ? String(a.cron) : null);
      const options = { ...defaultTaskOptions(), categories: (a.categories as { name: string; url: string }[] | undefined) ?? [], pagination: (a.pagination as never) ?? { type: "none" }, aiFallback: a.ai_fallback !== false, includeSourceUrl: true };
      const task = createRecipe(taskSchema.parse({
        name: a.name, url: a.url, mode: a.mode ?? "browser", extract: a.extract, options, tags: ["agent"],
        scheduleMinutes: a.schedule_minutes ? Math.max(15, Math.round(Number(a.schedule_minutes))) : null, cron: a.cron ?? null,
        description: "Created by the AI agent",
      }));
      audit("task.created", { taskId: task.id, by: "agent" });
      return j({ created: true, id: task.id, name: task.name, schedule: schedule(task), open: `/tasks/${task.id}` });
    },
  },
  set_task_schedule: {
    group: "Tasks & data", changes: true,
    describe: (a) => `Change the schedule of "${short(a.task)}" to ${a.paused ? "paused" : a.schedule_minutes ? `every ${a.schedule_minutes} min` : a.cron ? `"${a.cron}"` : "manual only"}.`,
    def: def("set_task_schedule", "Change when a saved task runs, or pause/resume it.", {
      task: str("Task id or name"), schedule_minutes: num("Every N minutes (15+), or 0 for manual"), cron: str("Cron schedule instead of minutes"), paused: bool("Pause or resume the schedule"),
    }, ["task"]),
    run: async (a) => {
      const t = findTask(a.task);
      if (typeof a.paused === "boolean" && a.schedule_minutes === undefined && a.cron === undefined) {
        setRecipeSchedulePaused(t.id, a.paused);
        audit("task.paused", { taskId: t.id, paused: a.paused, by: "agent" });
        return j({ ok: true, paused: a.paused });
      }
      validateCron(a.cron ? String(a.cron) : null);
      const minutes = Number(a.schedule_minutes ?? 0);
      const updated = updateRecipe(t.id, taskSchema.parse({ ...t, scheduleMinutes: minutes ? Math.max(15, Math.round(minutes)) : null, cron: a.cron ? String(a.cron) : null }));
      if (typeof a.paused === "boolean") setRecipeSchedulePaused(t.id, a.paused);
      audit("task.updated", { taskId: t.id, by: "agent" });
      return j({ ok: true, schedule: updated ? schedule(updated) : "manual" });
    },
  },
  delete_task: {
    group: "Tasks & data", changes: true,
    describe: (a) => `Delete the task "${short(a.task)}" (its past data stays in Data).`,
    def: def("delete_task", "Delete a saved task. Only when the user clearly asks.", { task: str("Task id or name") }, ["task"]),
    run: async (a) => { const t = findTask(a.task); deleteRecipe(t.id); audit("task.deleted", { taskId: t.id, by: "agent" }); return j({ deleted: t.name }); },
  },
  list_runs: {
    group: "Tasks & data", changes: false,
    def: def("list_runs", "List recent scrape results (data runs), optionally for one task.", { task: str("Task id or name, optional"), limit: num("Default 10") }),
    run: async (a) => {
      const recipeId = a.task ? findTask(a.task).id : undefined;
      return j(listRuns({ recipeId, limit: Math.min(50, Number(a.limit ?? 10)) }).items.map((r) => ({ id: r.id, task: r.recipe_name ?? null, url: r.url, status: r.status, rows: r.row_count, pages: r.page_count, at: r.created_at })));
    },
  },
  get_run_rows: {
    group: "Tasks & data", changes: false,
    def: def("get_run_rows", "Read rows from a data run (from list_runs or run_task).", { run_id: str("Run id"), offset: num("Default 0"), limit: num("Default 50, max 200"), columns: { type: "array", items: { type: "string" }, description: "Only these columns" } }, ["run_id"]),
    run: async (a) => {
      const run = getRun(String(a.run_id ?? ""));
      if (!run?.result) return "No run with that id (or it has no data).";
      const ds = run.result.datasets[mainDatasetIndex(run.result.datasets)]!;
      const cols = Array.isArray(a.columns) && a.columns.length ? (a.columns as string[]).filter((c) => ds.columns.includes(c)) : ds.columns;
      const off = Math.max(0, Number(a.offset ?? 0));
      const rows = ds.rows.slice(off, off + Math.min(200, Number(a.limit ?? 50))).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return j({ total: ds.rows.length, columns: cols, offset: off, rows });
    },
  },
  compare_runs: {
    group: "Tasks & data", changes: false,
    def: def("compare_runs", "Compare two data runs: rows added and removed, matched by key columns.", { run_a: str("Older run id"), run_b: str("Newer run id"), key: { type: "array", items: { type: "string" }, description: "Columns that identify a row, e.g. ['link']" } }, ["run_a", "run_b"]),
    run: async (a) => {
      const ra = getRun(String(a.run_a)); const rb = getRun(String(a.run_b));
      if (!ra?.result || !rb?.result) return "One of the runs was not found or has no data.";
      const da = ra.result.datasets[mainDatasetIndex(ra.result.datasets)]!; const dbs = rb.result.datasets[mainDatasetIndex(rb.result.datasets)]!;
      const d = compareRows(da.rows, dbs.rows, Array.isArray(a.key) ? (a.key as string[]) : [], dbs.columns);
      return j({ added: d.added.length, removed: d.removed.length, added_sample: d.added.slice(0, 10), removed_sample: d.removed.slice(0, 10) });
    },
  },

  // Watchers
  list_watchers: {
    group: "Watchers", changes: false,
    def: def("list_watchers", "List the user's website watchers and their status.", {}),
    run: async () => j(listWatchers().slice(0, 60).map((w) => ({ id: w.id, name: w.name, url: w.url, type: w.target.type, status: w.last_status, enabled: w.enabled, last_checked: w.last_checked_at, changes: w.change_count }))),
  },
  create_watcher: {
    group: "Watchers", changes: true,
    describe: (a) => `Watch ${short(a.url, 80)} as "${short(a.name)}" every ${Math.max(5, Math.round(Number(a.interval_minutes ?? 60)))} min, alerting on ${a.condition === "any_change" || !a.condition ? "any change" : `"${a.condition}"${a.text ? ` ${a.text}` : a.value !== undefined ? ` ${a.value}` : ""}`}.`,
    def: def("create_watcher", "Create a website watcher. Only when the user asks to watch or monitor something.", {
      name: str("Short name"), url: str("Page URL"), selector: str("Optional CSS selector to watch only part of the page"),
      condition: { type: "string", enum: ["any_change", "contains", "not_contains", "below", "above"], description: "When to alert" },
      text: str("Text for contains / not_contains"), value: num("Number for below / above"), interval_minutes: num("How often to check, minimum 5. Default 60."),
    }, ["name", "url", "condition"]),
    run: async (a) => {
      const cond = conditionSchema.parse(
        a.condition === "contains" || a.condition === "not_contains" ? { type: a.condition, text: a.text }
          : a.condition === "below" || a.condition === "above" ? { type: a.condition, value: Number(a.value) } : { type: "any_change" },
      );
      const numeric = cond.type === "below" || cond.type === "above";
      const sel = String(a.selector ?? "").trim();
      const input = watcherSchema.parse({
        name: a.name, url: a.url, mode: "browser",
        target: numeric ? { type: "price", selector: sel } : sel ? { type: "selector", selector: sel } : { type: "page" },
        condition: cond, notify: { desktop: true, webhook: false, telegram: false },
        intervalMinutes: Math.max(5, Math.round(Number(a.interval_minutes ?? 60))),
      });
      const w = createWatcher(input);
      audit("watcher.created", { watcherId: w.id, by: "agent" });
      return j({ created: true, id: w.id, name: w.name, checks_every_minutes: w.interval_minutes, open: `/watchers/${w.id}` });
    },
  },
  check_watcher: {
    group: "Watchers", changes: false,
    def: def("check_watcher", "Check a watcher now and report whether the page changed.", { watcher: str("Watcher id or name") }, ["watcher"]),
    run: async (a) => {
      const w = findWatcher(a.watcher);
      const job = await enqueueAndWait({ kind: "watch", refId: w.id, title: `Check: ${w.name}`, trigger: "agent", input: { watcherId: w.id }, unique: true }, 120_000);
      return j({ status: job.status, result: job.result, error: job.error });
    },
  },
  pause_watcher: {
    group: "Watchers", changes: true,
    describe: (a) => `${a.paused === false ? "Resume" : "Pause"} the watcher "${short(a.watcher)}".`,
    def: def("pause_watcher", "Pause or resume a watcher.", { watcher: str("Watcher id or name"), paused: bool("true = pause, false = resume") }, ["watcher", "paused"]),
    run: async (a) => { const w = findWatcher(a.watcher); setWatcherEnabled(w.id, a.paused === false); audit("watcher.updated", { watcherId: w.id, enabled: a.paused === false, by: "agent" }); return j({ ok: true, enabled: a.paused === false }); },
  },
  delete_watcher: {
    group: "Watchers", changes: true,
    describe: (a) => `Delete the watcher "${short(a.watcher)}" and its history.`,
    def: def("delete_watcher", "Delete a watcher. Only when the user clearly asks.", { watcher: str("Watcher id or name") }, ["watcher"]),
    run: async (a) => { const w = findWatcher(a.watcher); deleteWatcher(w.id); audit("watcher.deleted", { watcherId: w.id, by: "agent" }); return j({ deleted: w.name }); },
  },
  recent_changes: {
    group: "Watchers", changes: false,
    def: def("recent_changes", "List changes the user's watchers saw recently.", { hours: num("How far back, default 24, max 720") }),
    run: async (a) => {
      const hours = Math.min(720, Math.max(1, Number(a.hours ?? 24)));
      return j(changesSince(new Date(Date.now() - hours * 3600_000).toISOString()).slice(0, 60).map((r) => {
        let added: string[] = [];
        try { added = ((JSON.parse(r.diff ?? "{}") as { patch?: { op: string; text: string }[] }).patch ?? []).filter((p) => p.op === "+").slice(0, 5).map((p) => p.text.slice(0, 160)); } catch { /* old rows */ }
        return { watcher: r.name, url: r.url, at: r.created_at, added };
      }));
    },
  },

  // Prices & deals
  scan_deals: {
    group: "Prices & deals", changes: false,
    def: def("scan_deals", "Scan a shop listing page (for example an Amazon search or deals URL) and return items sorted by deal score.", { url: str("Listing URL, e.g. https://www.amazon.in/s?k=headphones"), min_discount: num("Minimum discount percent, default 0") }, ["url"]),
    run: async (a) => {
      const r = await scanListing({ url: urlArg(a), minDiscount: Number(a.min_discount ?? 0), rankWithAi: false });
      return j({ total: r.total, items: r.items.slice(0, 25).map((i) => ({ title: i.title.slice(0, 100), url: i.url, price: i.price, mrp: i.listPrice, discount: i.discount, rating: i.rating, reviews: i.reviews, sponsored: i.sponsored, deal_score: i.stats?.score ?? null, history: i.stats?.summary ?? "not tracked" })), notes: r.notes });
    },
  },
  price_history: {
    group: "Prices & deals", changes: false,
    def: def("price_history", "Get Scaper's own price history stats for a tracked product URL.", { url: str("Product URL") }, ["url"]),
    run: async (a) => {
      const p = getProductByUrl(canonicalProductUrl(urlArg(a)));
      if (!p) return "This product is not tracked yet, so there is no history. Use track_product if the user wants it tracked.";
      const s = withStats(p);
      return j({ title: s.title, price: s.current_price, currency: s.currency, stats: s.stats });
    },
  },
  list_tracked_products: {
    group: "Prices & deals", changes: false,
    def: def("list_tracked_products", "List products the user tracks with current price and deal score.", {}),
    run: async () => j(listProducts().slice(0, 60).map((p) => { const s = withStats(p); return { title: p.title?.slice(0, 90), url: p.url, price: p.current_price, mrp: p.list_price, score: s.stats.score, verdict: s.stats.verdict }; })),
  },
  track_product: {
    group: "Prices & deals", changes: true,
    describe: (a) => `Track the price of ${short(a.url, 90)}${a.target_price ? ` and alert at or below ${a.target_price}` : ""}.`,
    def: def("track_product", "Start tracking a product's price. Only when the user asks to track or watch a product.", { url: str("Product URL"), target_price: num("Alert when the price is at or below this, optional") }, ["url"]),
    run: async (a) => {
      const r = await trackProduct({ url: urlArg(a), targetPrice: a.target_price ? Number(a.target_price) : null, intervalMinutes: 360 });
      return j({ created: r.created, title: r.product.title, price: r.product.current_price, error: r.error ?? null, open: `/deals/${r.product.id}` });
    },
  },
  untrack_product: {
    group: "Prices & deals", changes: true,
    describe: (a) => `Stop tracking ${short(a.url, 90)} and delete its price history.`,
    def: def("untrack_product", "Stop tracking a product (deletes its price history). Only when the user clearly asks.", { url: str("Product URL") }, ["url"]),
    run: async (a) => {
      const p = getProductByUrl(canonicalProductUrl(urlArg(a)));
      if (!p) return "That product is not tracked.";
      deleteProduct(p.id);
      audit("product.deleted", { productId: p.id, by: "agent" });
      return j({ deleted: p.title ?? p.url });
    },
  },
  create_deal_search: {
    group: "Prices & deals", changes: true,
    describe: (a) => `Save the deal search "${short(a.name)}" for ${short(a.url, 80)}${a.schedule_minutes ? `, checking every ${a.schedule_minutes} min and alerting on new matches` : ""}.`,
    def: def("create_deal_search", "Save a deal search that runs on a schedule and alerts on new matching deals.", {
      name: str("Name"), url: str("Listing URL"), min_discount: num("Percent"), max_price: num("Highest price"), min_rating: num("0–5"), include: str("Words that must appear"), exclude: str("Words to skip"),
      schedule_minutes: num("Every N minutes (30+), optional"),
    }, ["name", "url"]),
    run: async (a) => {
      const filters = dealFiltersSchema.parse({ minDiscount: Number(a.min_discount ?? 0), maxPrice: a.max_price ? Number(a.max_price) : null, minRating: a.min_rating ? Number(a.min_rating) : null, include: a.include ?? "", exclude: a.exclude ?? "" });
      const s = createDealSearch(dealSearchSchema.parse({ name: a.name, url: a.url, filters, scheduleMinutes: a.schedule_minutes ? Math.max(30, Math.round(Number(a.schedule_minutes))) : null }));
      audit("deal_search.created", { id: s.id, by: "agent" });
      return j({ created: true, id: s.id, name: s.name, searches: listDealSearches().length });
    },
  },

  // Scaper
  notify_user: {
    group: "Scaper", changes: true,
    describe: (a) => `Send you an alert: "${short(a.title, 80)}" (to your inbox and alert channels).`,
    def: def("notify_user", "Send the user an alert in Scaper and their alert channels.", { title: str("Title"), body: str("Message") }, ["title", "body"]),
    run: async (a) => {
      await deliver({ kind: "agent", title: String(a.title).slice(0, 120), body: String(a.body).slice(0, 1500) }, { desktop: true, webhook: false, telegram: false });
      return "Alert sent.";
    },
  },
  site_info: {
    group: "Scaper", changes: false,
    def: def("site_info", "Show Scaper's rule for a site (delay, paused, robots) and its request stats for 30 days.", { host: str("Host name, e.g. www.amazon.in") }, ["host"]),
    run: async (a) => {
      const host = String(a.host ?? "").toLowerCase().trim();
      const rule = getSiteRule(host);
      return j({ host, rule: rule ? { delay_seconds: rule.delay_seconds, paused: rule.paused, respect_robots: rule.respect_robots, mode: rule.mode, notes: rule.notes, has_cookies: Boolean(rule.cookies) } : null, default_delay_seconds: getSettings().scraping.minDelaySeconds, stats: hostSummaries(30).find((h) => h.host === host) ?? null });
    },
  },
  slow_down_site: {
    group: "Scaper", changes: true,
    describe: (a) => `${a.paused ? "Pause all requests to" : `Wait ${a.delay_seconds ?? "longer"}s between requests to`} ${short(a.host)}.`,
    def: def("slow_down_site", "Make Scaper gentler with a site: a longer delay between requests, or pause it. (Site rules can only slow Scaper down.)", { host: str("Host name"), delay_seconds: num("Seconds between requests"), paused: bool("Pause the site") }, ["host"]),
    run: async (a) => {
      const host = String(a.host ?? "").toLowerCase().trim();
      const cur = getSiteRule(host);
      const delay = a.delay_seconds !== undefined ? Math.max(getSettings().scraping.minDelaySeconds, Number(a.delay_seconds)) : cur?.delay_seconds ?? null;
      const rule = upsertSiteRule({ host, delaySeconds: delay, mode: cur?.mode ?? null, userAgent: cur?.user_agent ?? "", headers: cur?.headers ?? [], cookies: "", respectRobots: cur?.respect_robots ?? null, paused: typeof a.paused === "boolean" ? a.paused : cur?.paused ?? false, notes: cur?.notes ?? "" }, true);
      audit("site.updated", { host, by: "agent" });
      return j({ host, delay_seconds: rule.delay_seconds, paused: rule.paused });
    },
  },
  remember: {
    group: "Scaper", changes: false,
    def: def("remember", "Save a short fact about the user for future conversations (their city, currency, favourite shops, sizes). Only facts the user told you.", { note: str("The fact, one sentence") }, ["note"]),
    run: async (a) => { const n = addMemory(String(a.note ?? ""), "agent"); return j({ saved: n.text, id: n.id }); },
  },
  forget: {
    group: "Scaper", changes: true,
    describe: (a) => `Delete the memory note ${short(a.id, 40)}.`,
    def: def("forget", "Delete one of the saved memory notes by id.", { id: str("Note id from the memory list") }, ["id"]),
    run: async (a) => (deleteMemory(String(a.id)) ? "Deleted." : "No note with that id."),
  },
  search_scaper: {
    group: "Scaper", changes: false,
    def: def("search_scaper", "Search the user's tasks, watchers, products and deal searches by name or URL.", { q: str("Search text") }, ["q"]),
    run: async (a) => {
      const q = String(a.q ?? "").toLowerCase();
      const has = (...xs: (string | null | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(q));
      return j({
        tasks: listRecipes().filter((t) => has(t.name, t.url, t.description)).slice(0, 10).map((t) => ({ id: t.id, name: t.name, url: t.url })),
        watchers: listWatchers().filter((w) => has(w.name, w.url, ...w.tags)).slice(0, 10).map((w) => ({ id: w.id, name: w.name, url: w.url })),
        products: listProducts().filter((p) => has(p.title, p.url, ...p.tags)).slice(0, 10).map((p) => ({ title: p.title, url: p.url, price: p.current_price })),
        deal_searches: listDealSearches().filter((d) => has(d.name, d.url)).slice(0, 10).map((d) => ({ id: d.id, name: d.name, url: d.url })),
      });
    },
  },
  ai_usage: {
    group: "Scaper", changes: false,
    def: def("ai_usage", "How many AI requests, tokens and dollars Scaper used today and this month, and the limits.", {}),
    run: async () => { const ai = getSettings().ai; return j({ today: aiUsageToday(), month: aiCostThisMonth(), daily_limit: ai.dailyRequestLimit, monthly_budget: ai.monthlyBudget || null }); },
  },
};

export const TOOL_DEFS: ToolDef[] = Object.values(TOOLS).map((t) => t.def);

/** For the agent page: what the agent can do, grouped, and which tools need your OK. */
export function toolCatalog() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, group: t.group, changes: t.changes, description: t.def.function.description }));
}

export function memoryForPrompt() {
  return listMemory().map((n) => `- ${n.text} (id ${n.id})`).join("\n");
}

