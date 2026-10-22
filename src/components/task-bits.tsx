import { BellRing, Bot, FileSpreadsheet, LayoutList, Network, Rows3, Table2 } from "lucide-react";
import type { Task } from "@/server/repo/scrapes";
import { defaultTaskOptions, type ExtractSpec, type FetchMode, type TaskOptions } from "@/lib/schemas";
import { scheduleText } from "@/lib/format";

export const isScheduled = (t: Pick<Task, "schedule_minutes" | "cron">) => Boolean(t.schedule_minutes || t.cron);
export const isPaused = (t: Pick<Task, "schedule_minutes" | "cron" | "next_run_at">) => isScheduled(t) && !t.next_run_at;

type Template = {
  id: string; title: string; description: string; icon: React.ReactNode;
  mode?: FetchMode; extract?: ExtractSpec; options?: Partial<TaskOptions>; scheduleMinutes?: number;
};

const f = (name: string, selector: string, attr = "text") => ({ name, selector, attr, multiple: false, transforms: [], required: false });

/** Starting points modelled on what people most often build in Apify, Octoparse and Browse AI. */
export const TEMPLATES: Template[] = [
  {
    id: "listing", title: "Product or search listing", icon: <LayoutList className="size-4 text-accent" />,
    description: "One row per card, across numbered pages. Pick the card, then name, price and link.",
    extract: { type: "selectors", itemSelector: "", fields: [f("name", ""), f("price", ""), f("link", "a", "href")] },
    options: { pagination: { type: "next", selector: "", maxPages: 5 } },
  },
  {
    id: "detail", title: "List, then each detail page", icon: <Rows3 className="size-4 text-accent" />,
    description: "Read the list, open every item's link and pull more fields from its own page.",
    extract: { type: "selectors", itemSelector: "", fields: [f("title", ""), f("link", "a", "href")] },
    options: { detail: { enabled: true, linkField: "link", fields: [f("description", "")] }, incremental: true },
  },
  {
    id: "table", title: "Tables on a page", icon: <Table2 className="size-4 text-accent" />,
    description: "Auto mode finds every HTML table, list and product block. No setup.",
    mode: "fast", extract: { type: "auto" },
  },
  {
    id: "crawl", title: "Crawl a section of a site", icon: <Network className="size-4 text-accent" />,
    description: "Follow links that match a pattern (like /blog/*) and read every page found.",
    extract: { type: "auto" }, mode: "fast",
    options: { crawl: { enabled: true, linkSelector: "a[href]", include: "/blog/*", exclude: "", maxDepth: 2, sameHost: true }, limits: { maxPages: 100, maxRows: 10_000 } },
  },
  {
    id: "inputs", title: "Same page for many inputs", icon: <FileSpreadsheet className="size-4 text-accent" />,
    description: "Paste a CSV of search terms or IDs; {{column}} in the URL is filled in for each row.",
    options: { inputs: "query\nwireless earbuds\nusb c cable" },
  },
  {
    id: "monitor", title: "Alert me about new listings", icon: <BellRing className="size-4 text-accent" />,
    description: "Runs every hour and alerts you when new rows appear (jobs, flats, products, posts).",
    extract: { type: "selectors", itemSelector: "", fields: [f("title", ""), f("link", "a", "href")] },
    options: { monitor: { enabled: true, keyFields: ["link"], notifyNew: true, notifyRemoved: false, channels: { desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false } } },
    scheduleMinutes: 60,
  },
  {
    id: "ai", title: "Describe it, let AI extract", icon: <Bot className="size-4 text-accent" />,
    description: "Say what you want in plain words. Uses your own model; good for messy pages.",
    extract: { type: "ai", instruction: "", fields: [], scope: "list", input: "main", useFastModel: true },
  },
];

export function templateOptions(t: Template): TaskOptions {
  return { ...defaultTaskOptions(), ...t.options };
}

/** One plain sentence per thing the task will do, for the editor's summary panel. */
export function describeTask(d: {
  url: string; mode: FetchMode; extract: ExtractSpec | { type: "selectors"; itemSelector: string; fields: { name: string }[] }; options: TaskOptions;
  startCount: number; scheduleMinutes: number | null; cron: string | null; channels: string[];
}): string[] {
  const o = d.options;
  const out: string[] = [];
  const starts = d.startCount + 1;
  const inputRows = o.inputs.trim() ? Math.max(0, o.inputs.trim().split(/\r?\n/).length - 1) : 0;
  out.push(`Opens ${starts > 1 ? `${starts} start pages` : "the start page"}${inputRows ? ` for each of ${inputRows} CSV rows` : ""}${o.sitemap.url ? ` plus up to ${o.sitemap.limit} pages from the sitemap` : ""} in ${d.mode === "browser" ? "a real browser" : "fast HTTP mode"}.`);
  if (o.steps.length) out.push(`Does ${o.steps.length} page action${o.steps.length === 1 ? "" : "s"} first (${o.steps.map((s) => s.action).join(", ")}).`);
  if (o.pagination.type === "next" || o.pagination.type === "click") out.push(`Goes through up to ${o.pagination.maxPages} pages using the Next ${o.pagination.type === "next" ? "link" : "button"}.`);
  if (o.pagination.type === "loadMore") out.push(`Clicks “Load more” up to ${o.pagination.times} times.`);
  if (o.pagination.type === "scroll") out.push(`Scrolls ${o.pagination.times} times to load more.`);
  if (o.crawl.enabled) out.push(`Follows links${o.crawl.include ? ` matching ${o.crawl.include}` : ""} up to ${o.crawl.maxDepth} level${o.crawl.maxDepth === 1 ? "" : "s"} deep${o.crawl.sameHost ? " on the same site" : ""}.`);
  const ex = d.extract;
  if (ex.type === "auto") out.push("Finds lists, tables and product data automatically.");
  else if (ex.type === "ai") out.push("Asks your AI model to extract the data you described.");
  else out.push(`Reads ${ex.fields.length} field${ex.fields.length === 1 ? "" : "s"} (${ex.fields.map((x) => x.name).filter(Boolean).slice(0, 5).join(", ")}${ex.fields.length > 5 ? " …" : ""})${ex.itemSelector ? " from each item" : ""}.`);
  if (o.detail.enabled) out.push(`Opens each item's “${o.detail.linkField}” and reads ${o.detail.fields.length} more field${o.detail.fields.length === 1 ? "" : "s"}${o.incremental ? ", skipping items seen before" : ""}.`);
  out.push(`Stops at ${o.limits.maxPages} pages or ${o.limits.maxRows.toLocaleString("en-IN")} rows.`);
  if (o.dedupeBy.length) out.push(`Removes duplicates by ${o.dedupeBy.join(" + ")}.`);
  if (o.quality.minRows || o.quality.minFillPercent) out.push(`Warns you if fewer than ${o.quality.minRows || 1} rows come back${o.quality.minFillPercent ? ` or a column is less than ${o.quality.minFillPercent}% full` : ""}.`);
  if (o.monitor.enabled) out.push(`Alerts on ${[o.monitor.notifyNew && "new", o.monitor.notifyRemoved && "removed"].filter(Boolean).join(" and ") || "no"} rows via ${d.channels.join(", ") || "the inbox"}.`);
  if (o.output.files.length) out.push(`Saves ${o.output.files.join(", ").toUpperCase()} files to the data folder after each run.`);
  if (o.output.webhook) out.push("Posts the rows to your webhook.");
  out.push(d.scheduleMinutes || d.cron ? `Runs ${scheduleText(d.scheduleMinutes, d.cron)}.` : "Runs when you press Run (no schedule).");
  return out;
}
