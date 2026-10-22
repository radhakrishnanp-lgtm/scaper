import "server-only";
import { z } from "zod";
import { dealSearchSchema, productAlertsSchema, siteRuleSchema, taskSchema, watcherSchema } from "@/lib/schemas";
import { createDealSearch, listDealSearches } from "../repo/deal-searches";
import { audit } from "../repo/events";
import { createProduct, listProducts } from "../repo/products";
import { createRecipe, listRecipes } from "../repo/scrapes";
import { listSiteRules, upsertSiteRule } from "../repo/sites";
import { createWatcher, listWatchers } from "../repo/watchers";
import { canonicalProductUrl, isAmazon, amazonAsin } from "../deals/parsers";

/** Everything you built, without history or secrets: move it to another machine or keep it in git. */
export function exportConfig() {
  return {
    format: "scaper-config", version: 2, exportedAt: new Date().toISOString(),
    tasks: listRecipes().map((r) => ({ name: r.name, description: r.description, url: r.url, mode: r.mode, extract: r.extract, options: r.options, tags: r.tags, scheduleMinutes: r.schedule_minutes, cron: r.cron })),
    watchers: listWatchers().map((w) => ({ name: w.name, url: w.url, mode: w.mode, target: w.target, condition: w.condition, notify: w.notify, intervalMinutes: w.interval_minutes, enabled: w.enabled, ignoreLines: w.ignore_lines, options: w.options, tags: w.tags })),
    products: listProducts().map((p) => ({ url: p.url, targetPrice: p.target_price, intervalMinutes: p.interval_minutes, tags: p.tags, alerts: p.alerts, notes: p.notes, groupName: p.group_name })),
    dealSearches: listDealSearches().map((d) => ({ name: d.name, url: d.url, filters: d.filters, rankWithAi: d.rank_with_ai, scheduleMinutes: d.schedule_minutes, notifyNew: d.notify_new })),
    // Cookies are left out on purpose: they are login sessions.
    siteRules: listSiteRules().map((s) => ({ host: s.host, delaySeconds: s.delay_seconds, mode: s.mode, userAgent: s.user_agent, headers: s.headers.filter((h) => !/auth|token|key|secret|cookie/i.test(h.name)), respectRobots: s.respect_robots, paused: s.paused, notes: s.notes })),
  };
}

const importSchema = z.object({
  format: z.literal("scaper-config"),
  tasks: z.array(z.unknown()).max(5000).default([]),
  watchers: z.array(z.unknown()).max(5000).default([]),
  products: z.array(z.unknown()).max(10000).default([]),
  dealSearches: z.array(z.unknown()).max(1000).default([]),
  siteRules: z.array(z.unknown()).max(2000).default([]),
});

const productImport = z.object({
  url: z.string().url(), targetPrice: z.number().positive().nullable().default(null), intervalMinutes: z.number().int().min(15).max(10080).default(360),
  tags: z.array(z.string().max(40)).max(12).default([]), alerts: productAlertsSchema.optional(),
});

export type ImportReport = Record<"tasks" | "watchers" | "products" | "dealSearches" | "siteRules", { added: number; skipped: number; errors: string[] }>;

/** Adds what is in the file. Existing items (same name and URL, or same product URL) are skipped, never overwritten. */
export function importConfig(raw: unknown): ImportReport {
  const data = importSchema.parse(raw);
  const report = Object.fromEntries(["tasks", "watchers", "products", "dealSearches", "siteRules"].map((k) => [k, { added: 0, skipped: 0, errors: [] as string[] }])) as ImportReport;
  const note = (k: keyof ImportReport, i: number, e: unknown) => {
    if (report[k].errors.length < 20) report[k].errors.push(`#${i + 1}: ${e instanceof z.ZodError ? e.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ") : (e as Error).message}`);
  };

  const taskKeys = new Set(listRecipes().map((r) => `${r.name}|${r.url}`));
  data.tasks.forEach((t, i) => {
    try {
      const v = taskSchema.parse(t);
      if (taskKeys.has(`${v.name}|${v.url}`)) { report.tasks.skipped++; return; }
      createRecipe(v); taskKeys.add(`${v.name}|${v.url}`); report.tasks.added++;
    } catch (e) { note("tasks", i, e); }
  });
  const watcherKeys = new Set(listWatchers().map((w) => `${w.name}|${w.url}`));
  data.watchers.forEach((w, i) => {
    try {
      const v = watcherSchema.parse(w);
      if (watcherKeys.has(`${v.name}|${v.url}`)) { report.watchers.skipped++; return; }
      createWatcher(v); watcherKeys.add(`${v.name}|${v.url}`); report.watchers.added++;
    } catch (e) { note("watchers", i, e); }
  });
  const productUrls = new Set(listProducts().map((p) => p.url));
  data.products.forEach((p, i) => {
    try {
      const v = productImport.parse(p);
      const url = canonicalProductUrl(v.url);
      if (productUrls.has(url)) { report.products.skipped++; return; }
      createProduct({ url, source: isAmazon(url) ? "amazon" : "web", externalId: amazonAsin(url), targetPrice: v.targetPrice, intervalMinutes: v.intervalMinutes, tags: v.tags, alerts: v.alerts });
      productUrls.add(url); report.products.added++;
    } catch (e) { note("products", i, e); }
  });
  const searchKeys = new Set(listDealSearches().map((d) => `${d.name}|${d.url}`));
  data.dealSearches.forEach((d, i) => {
    try {
      const v = dealSearchSchema.parse(d);
      if (searchKeys.has(`${v.name}|${v.url}`)) { report.dealSearches.skipped++; return; }
      createDealSearch(v); searchKeys.add(`${v.name}|${v.url}`); report.dealSearches.added++;
    } catch (e) { note("dealSearches", i, e); }
  });
  const hosts = new Set(listSiteRules().map((s) => s.host));
  data.siteRules.forEach((s, i) => {
    try {
      const v = siteRuleSchema.parse(s);
      if (hosts.has(v.host)) { report.siteRules.skipped++; return; }
      upsertSiteRule(v); hosts.add(v.host); report.siteRules.added++;
    } catch (e) { note("siteRules", i, e); }
  });
  audit("config.imported", Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.added])));
  return report;
}
