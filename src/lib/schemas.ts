import { z } from "zod";

/** Shared by the browser (form validation) and the server (request validation). */

export const urlSchema = z
  .string()
  .trim()
  .min(1, "Enter a URL")
  .max(2048, "URL is too long")
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
  .refine((v) => {
    try {
      const u = new URL(v);
      const okProtocol = u.protocol === "http:" || u.protocol === "https:";
      return okProtocol && (u.hostname.includes(".") || u.hostname === "localhost");
    } catch {
      return false;
    }
  }, "Enter a valid http(s) URL");

// "firecrawl": the page is loaded by your Firecrawl account and read here like any other page (your selectors, your AI).
export const fetchModeSchema = z.enum(["browser", "fast", "firecrawl"]);
export type FetchMode = z.infer<typeof fetchModeSchema>;

const selector = z.string().trim().min(1, "Selector is required").max(500);
const optionalSelector = z.string().trim().max(500).default("");

export const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(12).default([]);

/** A regular expression typed by the user; checked here so a typo is a form error, not a crash. */
const regexText = (label: string) =>
  z.string().max(300).default("").refine((v) => {
    if (!v) return true;
    try { new RegExp(v); return true; } catch { return false; }
  }, `${label} is not a valid regular expression`);

/** Clean-up steps applied to a field's value, in order. */
export const transformSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("trim") }),
  z.object({ op: z.literal("lower") }),
  z.object({ op: z.literal("upper") }),
  z.object({ op: z.literal("number") }),
  z.object({ op: z.literal("stripHtml") }),
  z.object({ op: z.literal("absoluteUrl") }),
  z.object({ op: z.literal("regex"), pattern: regexText("Pattern").refine((v) => v.length > 0, "Pattern is required"), group: z.number().int().min(0).max(9).default(1) }),
  z.object({ op: z.literal("replace"), find: z.string().min(1, "Find is required").max(300), with: z.string().max(300).default(""), regex: z.boolean().default(false) }),
  z.object({ op: z.literal("prefix"), value: z.string().max(300) }),
  z.object({ op: z.literal("suffix"), value: z.string().max(300) }),
  z.object({ op: z.literal("default"), value: z.string().max(300) }),
  z.object({ op: z.literal("split"), separator: z.string().min(1).max(20), index: z.number().int().min(-50).max(50).default(0) }),
]);
export type Transform = z.infer<typeof transformSchema>;

export const fieldSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(60)
    .regex(/^[\w\- ]+$/, "Use letters, numbers, spaces, - or _"),
  selector,
  // "text", "html", or any attribute name such as href or src
  attr: z.string().trim().max(60).default("text"),
  multiple: z.boolean().default(false),
  transforms: z.array(transformSchema).max(10).default([]),
  // Rows where a required field is empty are dropped.
  required: z.boolean().default(false),
});
export type Field = z.infer<typeof fieldSchema>;
/** A field as typed by hand or by other code: defaults may be left out. */
export type FieldInput = z.input<typeof fieldSchema>;

export const AI_FIELD_TYPES = ["text", "number", "url", "image", "boolean", "date", "list"] as const;
export const aiFieldSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60).regex(/^[\w\- ]+$/, "Use letters, numbers, spaces, - or _"),
  type: z.enum(AI_FIELD_TYPES).default("text"),
  description: z.string().trim().max(300).default(""),
});
export type AiField = z.infer<typeof aiFieldSchema>;

export const extractSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }),
  z.object({
    type: z.literal("selectors"),
    itemSelector: z.string().trim().max(500).optional().default(""),
    fields: z.array(fieldSchema).min(1, "Add at least one field").max(40),
  }),
  z.object({
    type: z.literal("ai"),
    instruction: z.string().trim().min(3, "Describe what to extract").max(2000),
    // Optional column list; without it the model picks the columns.
    fields: z.array(aiFieldSchema).max(30).default([]),
    // "list": one row per item on the page. "single": one row describing the page.
    scope: z.enum(["list", "single"]).default("list"),
    // "main": skip menus, headers and footers. "full": the whole page.
    input: z.enum(["main", "full"]).default("main"),
    useFastModel: z.boolean().default(true),
  }),
]);
export type ExtractSpec = z.infer<typeof extractSchema>;
export type AiExtractSpec = Extract<ExtractSpec, { type: "ai" }>;

/** Things to do in the browser before reading the page: accept a cookie banner, pick a city, type a search, log in to your own account. */
export const browserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), selector, optional: z.boolean().default(false) }),
  z.object({ action: z.literal("clickText"), text: z.string().trim().min(1).max(200), optional: z.boolean().default(false) }),
  z.object({ action: z.literal("check"), selector, checked: z.boolean().default(true) }),
  z.object({ action: z.literal("remove"), selector }),
  z.object({ action: z.literal("waitForText"), text: z.string().trim().min(1).max(200), timeoutSeconds: z.number().min(1).max(60).default(10) }),
  z.object({ action: z.literal("type"), selector, text: z.string().max(1000), submit: z.boolean().default(false) }),
  z.object({ action: z.literal("press"), key: z.string().trim().min(1).max(40) }),
  z.object({ action: z.literal("select"), selector, value: z.string().max(300) }),
  z.object({ action: z.literal("hover"), selector }),
  z.object({ action: z.literal("waitFor"), selector, timeoutSeconds: z.number().min(1).max(60).default(10) }),
  z.object({ action: z.literal("wait"), seconds: z.number().min(0.1).max(30) }),
  z.object({ action: z.literal("scroll"), times: z.number().int().min(1).max(50).default(3) }),
]);
export type BrowserStep = z.infer<typeof browserStepSchema>;

export const paginationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  // Follow the href of a "next page" link (works in both modes).
  z.object({ type: z.literal("next"), selector, maxPages: z.number().int().min(2).max(500).default(5) }),
  // Click a "next" button that has no link (browser mode).
  z.object({ type: z.literal("click"), selector, maxPages: z.number().int().min(2).max(200).default(5) }),
  // Infinite scroll (browser mode).
  z.object({ type: z.literal("scroll"), times: z.number().int().min(1).max(100).default(10) }),
  // "Load more" button (browser mode).
  z.object({ type: z.literal("loadMore"), selector, times: z.number().int().min(1).max(100).default(5) }),
]);
export type Pagination = z.infer<typeof paginationSchema>;

export const notifySchema = z.object({
  desktop: z.boolean().default(true),
  webhook: z.boolean().default(false),
  telegram: z.boolean().default(false),
  discord: z.boolean().default(false),
  slack: z.boolean().default(false),
  ntfy: z.boolean().default(false),
  email: z.boolean().default(false),
  whatsapp: z.boolean().default(false),
});
export type NotifyChannels = z.infer<typeof notifySchema>;
export const NOTIFY_CHANNELS = ["desktop", "webhook", "telegram", "discord", "slack", "ntfy", "email", "whatsapp"] as const;
export const EXTERNAL_CHANNELS = ["telegram", "ntfy", "email", "whatsapp", "discord", "slack", "webhook"] as const;
export type ExternalChannelName = (typeof EXTERNAL_CHANNELS)[number];

export const aiColumnSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60).regex(/^[\w\- ]+$/, "Use letters, numbers, spaces, - or _"),
  prompt: z.string().trim().min(3, "Say what the AI should fill in").max(1000),
  // Columns the AI reads; empty = all of them.
  from: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  useFastModel: z.boolean().default(true),
});
export type AiColumn = z.infer<typeof aiColumnSchema>;

/** One expectation about a task's data, checked on every run (Great Expectations / Soda style). */
export const VALIDATION_CHECKS = ["not_empty", "unique", "pattern", "range", "one_of", "type", "length", "row_count", "duplicates"] as const;
export const VALUE_TYPES = ["number", "url", "image", "date", "email", "integer", "boolean"] as const;
export const validationRuleSchema = z.object({
  id: z.string().trim().min(1).max(40),
  // A column name, or "*" for checks on the whole run (row count, duplicate rows).
  column: z.string().trim().min(1).max(60),
  check: z.enum(VALIDATION_CHECKS),
  // pattern: a regular expression; one_of: allowed values separated by "|"; type: one of VALUE_TYPES.
  arg: z.string().trim().max(500).default(""),
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  // Share of rows that must pass ("mostly"), so one odd row doesn't fail a run.
  mostly: z.number().min(1).max(100).default(100),
  severity: z.enum(["warn", "fail"]).default("fail"),
  enabled: z.boolean().default(true),
  note: z.string().trim().max(200).default(""),
}).superRefine((r, ctx) => {
  if (r.check === "pattern") {
    if (!r.arg) ctx.addIssue({ code: "custom", path: ["arg"], message: "Pattern is required" });
    else { try { new RegExp(r.arg); } catch { ctx.addIssue({ code: "custom", path: ["arg"], message: "Not a valid regular expression" }); } }
  }
  if (r.check === "one_of" && !r.arg) ctx.addIssue({ code: "custom", path: ["arg"], message: "List the allowed values, separated by |" });
  if (r.check === "type" && !(VALUE_TYPES as readonly string[]).includes(r.arg)) ctx.addIssue({ code: "custom", path: ["arg"], message: "Choose a type" });
  if (["range", "length", "row_count"].includes(r.check) && r.min === null && r.max === null) ctx.addIssue({ code: "custom", path: ["min"], message: "Set a minimum, a maximum or both" });
});
export type ValidationRule = z.infer<typeof validationRuleSchema>;

/** Apify actor ids look like "username~actor-name" (the URL form "username/actor-name" is accepted too). */
export const apifyActorIdSchema = z.string().trim().min(3, "Pick an actor").max(120)
  .transform((v) => v.replace(/^https?:\/\/(console\.)?apify\.com\/(actors\/)?/i, "").replace(/\/(input-schema|api|information).*$/i, "").replace("/", "~"))
  .refine((v) => /^[\w.-]+~[\w.-]+$|^[A-Za-z0-9]{17}$/.test(v), "Use the actor id, like apify~instagram-scraper");
export const taskSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("web") }),
  z.object({
    type: z.literal("apify"),
    actorId: apifyActorIdSchema,
    // The actor's JSON input, as shown on its Input tab in Apify.
    input: z.record(z.string(), z.unknown()).default({}),
    maxItems: z.number().int().min(1).max(100_000).default(200),
    timeoutSeconds: z.number().int().min(30).max(86_400).default(900),
    // Pay-per-result actors stop at this many US dollars per run. 0 = the actor's own limit.
    maxChargeUsd: z.number().min(0).max(1000).default(1),
  }),
]);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const taskOptionsSchema = z.object({
  // More start URLs, one per line. Ranges expand: https://site/page/{1..5}
  startUrls: z.array(z.string().trim().min(1).max(2048)).max(5000).default([]),
  sitemap: z.object({
    url: z.string().trim().max(2048).default(""),
    include: z.string().trim().max(300).default(""),
    limit: z.number().int().min(1).max(5000).default(100),
  }).default({ url: "", include: "", limit: 100 }),
  steps: z.array(browserStepSchema).max(30).default([]),
  pagination: paginationSchema.default({ type: "none" }),
  // Open each item's link and read more fields from its page ("list → detail").
  detail: z.object({
    enabled: z.boolean().default(false),
    linkField: z.string().trim().max(60).default("link"),
    fields: z.array(fieldSchema).max(30).default([]),
  }).default({ enabled: false, linkField: "link", fields: [] }),
  // Follow links that match a pattern and scrape those pages too.
  crawl: z.object({
    enabled: z.boolean().default(false),
    linkSelector: z.string().trim().max(500).default("a[href]"),
    include: z.string().trim().max(1000).default(""),
    exclude: z.string().trim().max(1000).default(""),
    maxDepth: z.number().int().min(1).max(5).default(1),
    sameHost: z.boolean().default(true),
  }).default({ enabled: false, linkSelector: "a[href]", include: "", exclude: "", maxDepth: 1, sameHost: true }),
  limits: z.object({
    maxPages: z.number().int().min(1).max(5000).default(50),
    maxRows: z.number().int().min(1).max(100_000).default(10_000),
  }).default({ maxPages: 50, maxRows: 10_000 }),
  dedupeBy: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  // CSV with a header row. Each row is one input; {{column}} in the URL and in typed text is replaced by its value.
  inputs: z.string().max(200_000).default(""),
  // Skip detail pages already scraped by an earlier run of this task.
  incremental: z.boolean().default(false),
  // Flag a run whose data looks broken (a selector stopped matching).
  quality: z.object({
    minRows: z.number().int().min(0).max(100_000).default(0),
    minFillPercent: z.number().min(0).max(100).default(0),
    alert: z.boolean().default(true),
  }).default({ minRows: 0, minFillPercent: 0, alert: true }),
  includeSourceUrl: z.boolean().default(false),
  retries: z.number().int().min(0).max(3).default(1),
  // Compare each run with the previous one and alert on new or removed rows.
  monitor: z.object({
    enabled: z.boolean().default(false),
    keyFields: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
    notifyNew: z.boolean().default(true),
    notifyRemoved: z.boolean().default(false),
    channels: notifySchema.default({ desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false, whatsapp: false }),
  }).default({ enabled: false, keyFields: [], notifyNew: true, notifyRemoved: false, channels: { desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false, whatsapp: false } }),
  output: z.object({
    files: z.array(z.enum(["csv", "json", "xlsx", "ndjson"])).max(4).default([]),
    webhook: z.boolean().default(false),
    // Copy the rows to a Google Sheet after each run: add them, replace the sheet, or update rows by key.
    sheets: z.object({
      enabled: z.boolean().default(false),
      spreadsheet: z.string().trim().max(300).default(""),
      sheet: z.string().trim().max(100).default("Sheet1"),
      mode: z.enum(["append", "upsert", "replace"]).default("upsert"),
      keyFields: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
    }).default({ enabled: false, spreadsheet: "", sheet: "Sheet1", mode: "upsert", keyFields: [] }),
  }).default({ files: [], webhook: false, sheets: { enabled: false, spreadsheet: "", sheet: "Sheet1", mode: "upsert", keyFields: [] } }),
  // Expectations checked on every run, with a score and issues tracked as new or resolved.
  validation: z.object({
    rules: z.array(validationRuleSchema).max(40).default([]),
    alert: z.enum(["off", "fail", "warn"]).default("fail"),
  }).default({ rules: [], alert: "fail" }),
  // Health alerts on top of plain failures: too few rows, too slow, or outside the usual range.
  health: z.object({
    minRows: z.number().int().min(0).max(1_000_000).nullable().default(null),
    maxDurationSeconds: z.number().int().min(1).max(86_400).nullable().default(null),
    anomaly: z.boolean().default(true),
    failStreak: z.number().int().min(1).max(20).default(2),
    recovered: z.boolean().default(true),
  }).default({ minRows: null, maxDurationSeconds: null, anomaly: true, failStreak: 2, recovered: true }),
  // When the task breaks: have the AI prepare new selectors and check them against the last good run.
  // "ask" keeps the fix for you to review, "auto" applies it when the check passes (you can roll back).
  heal: z.object({ mode: z.enum(["off", "ask", "auto"]).default("ask") }).default({ mode: "ask" }),
  // Category pages to read instead of the start URL; each row gets a "category" column.
  categories: z.array(z.object({ name: z.string().trim().min(1).max(120), url: z.string().trim().min(1).max(2048) })).max(500).default([]),
  // When the selectors find nothing on a page that loaded fine, let the AI read that page instead.
  aiFallback: z.boolean().default(false),
  // Extra columns the AI fills in from each row: a category, a translation, a short summary ...
  aiColumns: z.array(aiColumnSchema).max(5).default([]),
  aiColumnsMaxRows: z.number().int().min(1).max(5000).default(200),
  // Where the rows come from: web pages (default), or an Apify actor run on your account (its dataset becomes the rows).
  source: taskSourceSchema.default({ type: "web" }),
  // After each run, download the files linked in these columns (images, videos, PDFs) with the download manager.
  downloads: z.object({
    columns: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
    folder: z.string().trim().max(80).default(""),
    maxFiles: z.number().int().min(1).max(2000).default(100),
  }).default({ columns: [], folder: "", maxFiles: 100 }),
});
export type TaskOptions = z.infer<typeof taskOptionsSchema>;
export const defaultTaskOptions = (): TaskOptions => taskOptionsSchema.parse({});

const cronSchema = z.string().trim().max(120).nullable().default(null)
  .refine((v) => !v || /^(\S+\s+){4,5}\S+$/.test(v), "Use 5 or 6 cron fields, e.g. 0 9 * * 1-5");

export const scrapeRequestSchema = z.object({
  url: urlSchema,
  mode: fetchModeSchema.default("browser"),
  extract: extractSchema,
  screenshot: z.boolean().default(false),
  recipeId: z.string().uuid().optional(),
  options: taskOptionsSchema.optional(),
  // Private: keep the result in memory only (overrides the private mode setting when set).
  private: z.boolean().optional(),
});

export const taskSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(1000).default(""),
  url: urlSchema,
  mode: fetchModeSchema,
  extract: extractSchema,
  options: taskOptionsSchema.default(defaultTaskOptions()),
  tags: tagsSchema,
  // Run automatically: every N minutes, or on a cron schedule. Both null = manual only.
  scheduleMinutes: z.number().int().min(15).max(10080).nullable().default(null),
  cron: cronSchema,
});
export type TaskInput = z.infer<typeof taskSchema>;
/** Older name, kept for saved recipes and the API. */
export const recipeSchema = taskSchema;

export const watchTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page") }),
  z.object({ type: z.literal("selector"), selector }),
  z.object({ type: z.literal("price"), selector: optionalSelector }),
  // Pixel comparison of a screenshot (browser mode). Threshold = % of pixels that must change.
  z.object({ type: z.literal("visual"), selector: optionalSelector, threshold: z.number().min(0.01).max(100).default(1) }),
  // A JSON API response; path like data.items[0].price (empty = whole document).
  z.object({ type: z.literal("json"), path: z.string().trim().max(300).default("") }),
  // RSS or Atom feed: one line per item, so "lines added" means new posts.
  z.object({ type: z.literal("feed") }),
  // sitemap.xml: one line per URL, so "lines added" means new pages.
  z.object({ type: z.literal("sitemap"), include: z.string().trim().max(300).default("") }),
  // Uptime: alert when the page is down, slow, or returns an unexpected status.
  z.object({ type: z.literal("status"), maxMs: z.number().int().min(100).max(120_000).nullable().default(null) }),
]);
export type WatchTarget = z.infer<typeof watchTargetSchema>;

// Which text a condition looks at: the whole content, or only the lines added / removed by this change.
const conditionScope = z.enum(["all", "added", "removed"]).default("all");

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("any_change") }),
  z.object({ type: z.literal("contains"), text: z.string().trim().min(1).max(500), scope: conditionScope }),
  z.object({ type: z.literal("not_contains"), text: z.string().trim().min(1).max(500), scope: conditionScope }),
  z.object({ type: z.literal("regex"), pattern: regexText("Pattern").refine((v) => v.length > 0, "Pattern is required"), scope: conditionScope }),
  z.object({ type: z.literal("below"), value: z.number().nonnegative() }),
  z.object({ type: z.literal("above"), value: z.number().nonnegative() }),
  z.object({ type: z.literal("drop_percent"), percent: z.number().min(0.1).max(100) }),
  z.object({ type: z.literal("rise_percent"), percent: z.number().min(0.1).max(1000) }),
  z.object({ type: z.literal("in_stock") }),
  z.object({ type: z.literal("ai"), question: z.string().trim().min(5).max(1000) }),
]);
export type Condition = z.infer<typeof conditionSchema>;
export type ConditionInput = z.input<typeof conditionSchema>;

export const watcherOptionsSchema = z.object({
  steps: z.array(browserStepSchema).max(20).default([]),
  // Keep only lines matching this pattern before comparing.
  onlyMatching: regexText("Keep-lines pattern"),
  // Drop lines matching this pattern.
  ignoreRegex: regexText("Ignore pattern"),
  ignoreNumbers: z.boolean().default(false),
  ignoreCase: z.boolean().default(false),
  // Alert on any change, or only when lines are added / removed.
  triggerOn: z.enum(["any", "added", "removed"]).default("any"),
  // Save a screenshot with every change (browser mode).
  screenshot: z.boolean().default(false),
  // After an alert, stay quiet for this many minutes.
  cooldownMinutes: z.number().int().min(0).max(10080).default(0),
  // Add a one-line AI summary of what changed to each alert.
  aiSummary: z.boolean().default(false),
  // Let the AI mark each change important or not (it learns from your "not useful" feedback).
  aiImportance: z.boolean().default(false),
  // Only alert on changes the AI marks important (needs aiImportance).
  importantOnly: z.boolean().default(false),
  // Extra conditions, combined with the main one.
  moreConditions: z.array(conditionSchema).max(9).default([]),
  match: z.enum(["all", "any"]).default("all"),
  // Cron schedule instead of the plain interval (e.g. "0 9-18 * * 1-5").
  cron: z.string().trim().max(120).nullable().default(null),
  // Only check during these hours and days (local time).
  activeHours: z.object({
    enabled: z.boolean().default(false),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").default("09:00"),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").default("18:00"),
    days: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
  }).default({ enabled: false, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] }),
});
export type WatcherOptions = z.infer<typeof watcherOptionsSchema>;
export const defaultWatcherOptions = (): WatcherOptions => watcherOptionsSchema.parse({});

export const watcherSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  url: urlSchema,
  mode: fetchModeSchema.default("browser"),
  target: watchTargetSchema,
  condition: conditionSchema,
  notify: notifySchema,
  intervalMinutes: z.number().int().min(1).max(10080),
  enabled: z.boolean().default(true),
  // Lines containing any of these phrases are ignored (dates, view counters, ads ...).
  ignoreLines: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  options: watcherOptionsSchema.default(defaultWatcherOptions()),
  tags: tagsSchema,
});
export type WatcherInput = z.infer<typeof watcherSchema>;

export const bulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["pause", "resume", "check", "delete", "tag", "untag"]),
  tag: z.string().trim().min(1).max(40).optional(),
});

export const productAlertsSchema = z.object({
  dropPercent: z.number().min(1).max(95).nullable().default(null),
  newLow: z.boolean().default(true),
  backInStock: z.boolean().default(true),
  channels: notifySchema.nullable().default(null),
});
export type ProductAlerts = z.infer<typeof productAlertsSchema>;

export const productInputSchema = z.object({
  url: urlSchema,
  targetPrice: z.number().positive().nullable().optional(),
  intervalMinutes: z.number().int().min(15).max(10080).default(360),
  tags: tagsSchema.optional(),
  alerts: productAlertsSchema.optional(),
});

export const productBulkSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(200),
  intervalMinutes: z.number().int().min(15).max(10080).default(360),
  tags: tagsSchema.optional(),
});

export const productPatchSchema = z.object({
  targetPrice: z.number().positive().nullable().optional(),
  intervalMinutes: z.number().int().min(15).max(10080).optional(),
  enabled: z.boolean().optional(),
  tags: tagsSchema.optional(),
  alerts: productAlertsSchema.optional(),
  notes: z.string().max(2000).optional(),
  // Products with the same group name (the same item at different stores) are compared side by side.
  groupName: z.string().trim().max(120).optional(),
});

export const dealFiltersSchema = z.object({
  minDiscount: z.number().min(0).max(95).default(0),
  maxPrice: z.number().positive().nullable().default(null),
  minRating: z.number().min(0).max(5).nullable().default(null),
  minReviews: z.number().int().min(0).nullable().default(null),
  include: z.string().trim().max(300).default(""),
  exclude: z.string().trim().max(300).default(""),
  hideSponsored: z.boolean().default(false),
});
export type DealFilters = z.infer<typeof dealFiltersSchema>;

export const dealScanSchema = z.object({
  url: urlSchema,
  minDiscount: z.number().min(0).max(95).default(0),
  rankWithAi: z.boolean().default(false),
  filters: dealFiltersSchema.optional(),
});

export const dealSearchSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  url: urlSchema,
  filters: dealFiltersSchema.default(dealFiltersSchema.parse({})),
  rankWithAi: z.boolean().default(false),
  scheduleMinutes: z.number().int().min(30).max(10080).nullable().default(null),
  notifyNew: z.boolean().default(true),
});
export type DealSearchInput = z.infer<typeof dealSearchSchema>;

export const agentRequestSchema = z.object({
  prompt: z.string().trim().min(3, "Tell the agent what to do").max(4000),
  useFastModel: z.boolean().default(false),
  /** "main", "fast" or "<providerId>::<model>" for any saved model. */
  model: z.string().trim().max(260).optional(),
  /** Continue the conversation of an earlier run. */
  followUpOf: z.string().max(40).optional(),
  private: z.boolean().optional(),
});

export const siteRuleSchema = z.object({
  host: z.string().trim().toLowerCase().min(1, "Host is required").max(253).regex(/^[a-z0-9.-]+$/, "Use a host name like www.example.com"),
  delaySeconds: z.number().min(1).max(600).nullable().default(null),
  mode: fetchModeSchema.nullable().default(null),
  userAgent: z.string().trim().max(400).default(""),
  headers: z.array(z.object({ name: z.string().trim().min(1).max(100).regex(/^[\w-]+$/, "Invalid header name"), value: z.string().max(2000) })).max(20).default([]),
  // Cookie header for pages you are allowed to see, e.g. your own logged-in account.
  cookies: z.string().max(8000).default(""),
  respectRobots: z.boolean().nullable().default(null),
  paused: z.boolean().default(false),
  notes: z.string().max(1000).default(""),
});
export type SiteRuleInput = z.infer<typeof siteRuleSchema>;

export const aiModelSchema = z.object({
  id: z.string().trim().min(1, "Model id is required").max(200),
  // Tokens the model can read at once; null = use the default context size.
  contextWindow: z.number().int().min(1000).max(10_000_000).nullable().default(null),
  // US dollars per million tokens, for cost tracking. 0 = free or unknown.
  inputPrice: z.number().min(0).max(10_000).default(0),
  outputPrice: z.number().min(0).max(10_000).default(0),
  // What a capability test found; null = not tested.
  tools: z.boolean().nullable().default(null),
  json: z.boolean().nullable().default(null),
});
export type AiModel = z.infer<typeof aiModelSchema>;

export const aiProviderSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[\w-]+$/, "Use letters, numbers, - or _"),
  name: z.string().trim().min(1, "Name is required").max(60),
  baseUrl: z.string().trim().min(1, "Base URL is required").max(500).regex(/^https?:\/\/\S+$/i, "Start with http:// or https://"),
  apiKey: z.string().trim().max(1000).default(""),
  // How the key is sent: "Authorization: Bearer <key>" (most providers), an "api-key" header (Azure), or not at all (local models).
  auth: z.enum(["bearer", "api-key", "none"]).default("bearer"),
  headers: z.array(z.object({
    name: z.string().trim().min(1).max(100).regex(/^[\w-]+$/, "Header names use letters, numbers and -"),
    value: z.string().max(1000),
  })).max(10).default([]),
  models: z.array(aiModelSchema).max(200).default([]),
  timeoutSeconds: z.number().int().min(5).max(900).default(120),
  enabled: z.boolean().default(true),
});
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const modelRefSchema = z.object({ providerId: z.string().trim().max(40).default(""), model: z.string().trim().max(200).default("") });
export type ModelRef = z.infer<typeof modelRefSchema>;

/**
 * A decision model (OpenRouter Decisions API): reads a page or a proposed action and answers typed questions with
 * probabilities. Scaper uses it to pick which links hold what you want, to check a page before scraping it and to
 * double-check the agent's actions. Code applies the thresholds; the model never decides alone.
 */
export const decisionSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  // Which saved provider's key to use (OpenRouter). The endpoint is derived from its base URL unless set below.
  providerId: z.string().trim().max(40).default(""),
  model: z.string().trim().max(200).default("openai/gpt-6-luna-decisions"),
  // Empty = <provider base without /v1>/alpha/decisions, e.g. https://openrouter.ai/api/alpha/decisions.
  url: z.string().trim().max(500).regex(/^(https?:\/\/\S+)?$/i, "Start with http:// or https://").default(""),
  // US dollars per million input tokens, for cost tracking when the provider does not report cost.
  inputPrice: z.number().min(0).max(10_000).default(0.1),
  pickLinks: z.boolean().default(true),
  scrapeCheck: z.boolean().default(true),
  agentGuard: z.boolean().default(true),
  // How sure the model must be (0.5 = more likely than not) before a link counts as a match or a risk is flagged.
  linkThreshold: z.number().min(0.05).max(0.99).default(0.5),
  riskThreshold: z.number().min(0.05).max(0.99).default(0.5),
});
export type DecisionSettings = z.infer<typeof decisionSettingsSchema>;

/** The agent as a supervisor: it can start helper agents, write their instructions and share a memory with them. */
export const teamSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  // Helper agents one conversation may have at once (the supervisor not counted).
  maxAgents: z.number().int().min(1).max(5).default(5),
  // Steps (model calls) each helper may take before it must report.
  workerSteps: z.number().int().min(2).max(30).default(10),
  // Which model helpers use unless the supervisor picks one.
  workerModel: z.enum(["main", "fast"]).default("fast"),
  // Keep the instructions that worked as playbooks and improve them with each use.
  evolve: z.boolean().default(true),
});
export type TeamSettings = z.infer<typeof teamSettingsSchema>;

/** How the agent learns: an always-current guide to Scaper, its own Markdown notes and a review of each finished job. */
export const learningSettingsSchema = z.object({
  guide: z.boolean().default(true),
  notes: z.boolean().default(true),
  selfReview: z.boolean().default(true),
  // Runs with fewer tool calls than this are not reviewed (a plain question does not need one).
  reviewMinSteps: z.number().int().min(0).max(20).default(2),
});
export type LearningSettings = z.infer<typeof learningSettingsSchema>;

export const aiSettingsSchema = z.object({
  // Single-provider fields from older versions. Saving them updates the provider called "default".
  baseUrl: z.string().trim().max(500).default(""),
  apiKey: z.string().trim().max(500).default(""),
  model: z.string().trim().max(200).default(""),
  fastModel: z.string().trim().max(200).default(""),
  providers: z.array(aiProviderSchema).max(12).default([]),
  main: modelRefSchema.default({ providerId: "", model: "" }),
  fast: modelRefSchema.default({ providerId: "", model: "" }),
  // Tried in order when the main or fast model fails (network error, rate limit, outage).
  fallbacks: z.array(modelRefSchema).max(3).default([]),
  dailyRequestLimit: z.number().int().min(1).max(100000).default(300),
  // US dollars per calendar month across all models. 0 = no budget.
  monthlyBudget: z.number().min(0).max(100_000).default(0),
  maxTokens: z.number().int().min(64).max(128_000).default(2000),
  temperature: z.number().min(0).max(2).default(0.2),
  // How much page text goes to the model when its context window is unknown.
  contextTokens: z.number().int().min(2000).max(1_000_000).default(24_000),
  agentMaxSteps: z.number().int().min(1).max(40).default(12),
  // "ask": the agent waits for your OK before changing anything. "auto": it goes ahead.
  agentApproval: z.enum(["ask", "auto"]).default("ask"),
  // Added to every agent conversation: who you are, your country, currency, preferred shops ...
  instructions: z.string().max(4000).default(""),
  // Keep the full prompt and reply of each AI call in the AI log.
  logPrompts: z.boolean().default(true),
  keepCallsDays: z.number().int().min(1).max(365).default(60),
  // Reuse the answer to an identical request for this many hours (extraction, selectors). 0 = off.
  cacheHours: z.number().int().min(0).max(720).default(0),
  decisions: decisionSettingsSchema.default(decisionSettingsSchema.parse({})),
  team: teamSettingsSchema.default(teamSettingsSchema.parse({})),
  learning: learningSettingsSchema.default(learningSettingsSchema.parse({})),
});

export const scrapingSettingsSchema = z.object({
  userAgent: z.string().trim().max(400).default(""),
  minDelaySeconds: z.number().min(1).max(600).default(5),
  respectRobots: z.boolean().default(true),
  // One proxy you control: an office proxy or the local HTTP/SOCKS5 proxy of your VPN app.
  proxyUrl: z.string().trim().max(500).regex(/^((https?|socks5h?):\/\/\S+)?$/i, "Use http://, https:// or socks5://").default(""),
  // Send AI requests through the proxy too (otherwise they go direct, or via HTTPS_PROXY).
  proxyAi: z.boolean().default(false),
  maxConcurrency: z.number().int().min(1).max(4).default(2),
  jobConcurrency: z.number().int().min(1).max(8).default(3),
  blockHeavyResources: z.boolean().default(true),
  allowPrivateNetwork: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(5).max(120).default(30),
  // Chrome, Edge, Brave or Chromium already on this computer; empty = the browser Scaper installs.
  browserPath: z.string().trim().max(1000).default(""),
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const ALERT_EVENTS = ["taskDone", "taskFailed", "newRows", "watcherChange", "priceAlert", "dealFound", "botUpdate", "botApproval"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];
const routeSchema = z.array(z.enum([...EXTERNAL_CHANNELS, "all"])).max(8);
export const DEFAULT_ROUTES: Record<AlertEvent, ("all" | ExternalChannelName)[]> = {
  taskDone: [], taskFailed: ["all"], newRows: [], watcherChange: [], priceAlert: [], dealFound: ["all"], botUpdate: [], botApproval: ["all"],
};
export const alertRoutesSchema = z.object(Object.fromEntries(ALERT_EVENTS.map((e) => [e, routeSchema.default(DEFAULT_ROUTES[e])])) as Record<AlertEvent, z.ZodDefault<typeof routeSchema>>)
  .default(DEFAULT_ROUTES);
export type AlertRoutes = z.infer<typeof alertRoutesSchema>;

export const notificationSettingsSchema = z.object({
  webhookUrl: z.string().trim().max(1000).default(""),
  telegramBotToken: z.string().trim().max(200).default(""),
  telegramChatId: z.string().trim().max(100).default(""),
  discordWebhookUrl: z.string().trim().max(1000).default(""),
  slackWebhookUrl: z.string().trim().max(1000).default(""),
  ntfyUrl: z.string().trim().max(1000).default(""),
  ntfyToken: z.string().trim().max(300).default(""),
  smtpHost: z.string().trim().max(300).default(""),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().trim().max(300).default(""),
  smtpPass: z.string().max(300).default(""),
  emailFrom: z.string().trim().max(300).default(""),
  emailTo: z.string().trim().max(1000).default(""),
  // WhatsApp: the official Cloud API (Meta), or CallMeBot (free, for messages to your own number).
  whatsappProvider: z.enum(["cloud", "callmebot"]).default("cloud"),
  whatsappToken: z.string().trim().max(1000).default(""),
  whatsappPhoneId: z.string().trim().max(40).default(""),
  whatsappTo: z.string().trim().max(40).default(""),
  // Outside WhatsApp's 24-hour window only an approved template can be sent; leave empty to send plain text.
  whatsappTemplate: z.string().trim().max(120).default(""),
  whatsappTemplateLang: z.string().trim().max(10).default("en"),
  callmebotKey: z.string().trim().max(100).default(""),
  // Where each kind of alert goes, on top of the channels picked on the task, watcher or product.
  // "all" = every channel you have set up.
  routes: alertRoutesSchema,
  quietHoursEnabled: z.boolean().default(false),
  quietStart: clock.default("22:00"),
  quietEnd: clock.default("07:00"),
  failureAlertAfter: z.number().int().min(1).max(50).default(3),
  errorAlertCooldownMinutes: z.number().int().min(0).max(10080).default(360),
  // Pause every external channel at once (alerts still reach the inbox).
  muteAll: z.boolean().default(false),
  // A briefing with everything that changed: daily or weekly, optionally written by your AI.
  digest: z.enum(["off", "daily", "weekly"]).default("off"),
  digestHour: z.number().int().min(0).max(23).default(8),
  digestDay: z.number().int().min(0).max(6).default(1),
  digestTags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  digestTagMatch: z.enum(["any", "all"]).default("any"),
  digestAi: z.boolean().default(false),
  // Skip the briefing when nothing important changed.
  digestSkipQuiet: z.boolean().default(true),
});

export const WEBHOOK_EVENTS = ["task.finished", "task.failed", "task.health", "watcher.change", "price", "alert"] as const;
export const webhookEndpointSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1, "Name is required").max(80),
  url: z.string().trim().url("Use a full URL starting with https://").max(1000),
  secret: z.string().max(200).default(""),
  events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).default([...WEBHOOK_EVENTS]),
  enabled: z.boolean().default(true),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

export const integrationSettingsSchema = z.object({
  webhooks: z.array(webhookEndpointSchema).max(10).default([]),
  // Retry failed webhook deliveries with backoff (30 s, 2 min, 10 min, 1 h, 6 h).
  webhookRetries: z.boolean().default(true),
  // Google service account key (JSON) for Sheets sync. Share each sheet with the account's email.
  googleServiceAccount: z.string().max(10_000).default(""),
  // MCP: AI apps like Claude Desktop, Claude Code and Cursor can use Scaper's tools with an API token.
  mcpEnabled: z.boolean().default(true),
  mcpAllowWrite: z.boolean().default(false),
  // Firecrawl (firecrawl.dev or your own server): loads pages and searches the web with your key. Your LLM reads the result.
  firecrawlKey: z.string().trim().max(300).default(""),
  firecrawlUrl: z.string().trim().max(300).regex(/^https?:\/\/\S+$/i, "Start with http:// or https://").default("https://api.firecrawl.dev"),
  // Apify: run actors from the Apify Store (YouTube, Instagram, TikTok …) on your account.
  apifyToken: z.string().trim().max(300).default(""),
  // A safety cap for any one actor run started by the agent or a bot (US dollars, pay-per-result actors).
  apifyMaxChargeUsd: z.number().min(0).max(1000).default(1),
});

export const dataSettingsSchema = z.object({
  keepRuns: z.number().int().min(20).max(100_000).default(1000),
  keepSnapshots: z.number().int().min(10).max(10_000).default(300),
  keepJobsDays: z.number().int().min(1).max(365).default(30),
  keepEventsDays: z.number().int().min(1).max(365).default(30),
  autoBackup: z.boolean().default(true),
  keepBackups: z.number().int().min(1).max(60).default(7),
  // Quick scrapes, AI extraction, category scrapes and agent chats are kept in memory only, never on disk.
  privateMode: z.boolean().default(false),
  // Download manager: files at once, the largest file allowed, and whether downloads continue after a restart.
  downloadConcurrency: z.number().int().min(1).max(8).default(3),
  maxDownloadMb: z.number().int().min(1).max(50_000).default(2048),
  // Scaper's own visual browser: picture quality of the live view, start page, search, history.
  browserQuality: z.number().int().min(30).max(95).default(70),
  /** Which engine runs the Browser page: Scaper's Chromium, the Chrome or Edge on this computer, or Firefox. */
  browserEngine: z.enum(["chromium", "chrome", "msedge", "firefox"]).default("chromium"),
  /** Also show the browser as a real window on this computer (you can use it there directly). */
  browserWindow: z.boolean().default(false),
  browserHome: z.string().trim().max(500).default("https://duckduckgo.com/"),
  browserSearch: z.string().trim().max(500).refine((v) => v.includes("%s"), "Put %s where the search words go.").default("https://duckduckgo.com/?q=%s"),
  browserHistory: z.boolean().default(true),
  browserHistoryDays: z.number().int().min(1).max(3650).default(90),
});

export const settingsSchema = z.object({
  ai: aiSettingsSchema,
  scraping: scrapingSettingsSchema,
  notifications: notificationSettingsSchema,
  data: dataSettingsSchema,
  integrations: integrationSettingsSchema.default(integrationSettingsSchema.parse({})),
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = z.object({
  ai: aiSettingsSchema.partial().optional(),
  scraping: scrapingSettingsSchema.partial().optional(),
  notifications: notificationSettingsSchema.partial().optional(),
  data: dataSettingsSchema.partial().optional(),
  integrations: integrationSettingsSchema.partial().optional(),
});

export const apiTokenSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(80) });

export const loginSchema = z.object({ password: z.string().min(1).max(500) });

/** A note written or edited by you on the knowledge screen. */
export const noteInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  kind: z.enum(["how-to", "site", "lesson", "reference"]).default("how-to"),
  body: z.string().trim().min(1, "Write something").max(20_000),
});

// ---------------------------------------------------------------------------------------------
// Bots: your own agents, each with one job, instructions, a schedule and/or events that wake it,
// what it may do on its own, its own memory, and where it tells you.

export const BOT_EVENTS = ["task.finished", "task.failed", "watcher.change", "price.alert", "deal.found", "task.alert"] as const;
export type BotEvent = (typeof BOT_EVENTS)[number];
export const MAX_ACTIVE_BOTS = 20;

export const botScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(5, "At least every 5 minutes").max(10_080) }),
  // At HH:MM on the chosen weekdays (0 = Sunday); no days = every day.
  z.object({ type: z.literal("daily"), time: clock, days: z.array(z.number().int().min(0).max(6)).max(7).default([]) }),
]);
export type BotSchedule = z.infer<typeof botScheduleSchema>;

export const botTriggerSchema = z.object({
  event: z.enum(BOT_EVENTS),
  // A task, watcher, product or deal search id; null = any.
  refId: z.string().trim().max(60).nullable().default(null),
});

export const botSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  emoji: z.string().trim().max(8).default("🤖"),
  role: z.string().trim().min(3, "Say what this bot is for").max(200),
  task: z.string().trim().min(5, "Describe the bot's job").max(4000),
  instructions: z.string().trim().max(4000).default(""),
  schedule: botScheduleSchema.default({ type: "manual" }),
  triggers: z.array(botTriggerSchema).max(10).default([]),
  // Only tell me when this is true (the bot decides from what it found).
  condition: z.string().trim().max(500).default(""),
  // The bot pauses itself once this is true, like a monitoring task with an end.
  stopWhen: z.string().trim().max(500).default(""),
  permission: z.enum(["read", "ask", "auto"]).default("ask"),
  model: z.enum(["main", "fast"]).default("main"),
  maxSteps: z.number().int().min(2).max(60).default(15),
  helpers: z.boolean().default(false),
  memory: z.boolean().default(true),
  notify: notifySchema.default({ desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false, whatsapp: false }),
  // always = send each run's result; important = only when the bot calls notify_owner; off = inbox only.
  notifyMode: z.enum(["always", "important", "off"]).default("important"),
  // Wait at least this long between runs started by events.
  cooldownMinutes: z.number().int().min(1).max(1440).default(10),
  // After each run the bot grades itself against its job and your feedback, and keeps up to 10 lessons in its memory.
  selfEval: z.boolean().default(true),
});
export type BotInput = z.infer<typeof botSchema>;
export const botPatchSchema = botSchema.partial().extend({ enabled: z.boolean().optional() });

export const botMemoryInputSchema = z.object({
  key: z.string().trim().min(1, "Name the fact").max(80),
  value: z.string().trim().min(1, "Write the fact").max(2000),
});

export const botFeedbackSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  note: z.string().trim().max(1000).default(""),
});

export const downloadInputSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(4096)).min(1, "Add at least one link").max(2000),
  folder: z.string().trim().max(80).default(""),
});

// The file finder: pages that list files, often with a second page that has the real download link.
export const FILE_KINDS = {
  pdf: ["pdf"],
  ebook: ["epub", "mobi", "azw", "azw3", "fb2", "djvu", "cbz", "cbr"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "tif", "tiff", "bmp"],
  video: ["mp4", "webm", "mkv", "mov", "m4v", "avi"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"],
  document: ["doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"],
} as const;
export type FileKind = keyof typeof FILE_KINDS;
export const fileKindSchema = z.enum(Object.keys(FILE_KINDS) as [FileKind, ...FileKind[]]);

export const fileFinderSchema = z.object({
  urls: z.array(z.string().trim().url("Enter a full link, starting with http:// or https://").max(2048)).min(1, "Add at least one page").max(500),
  kinds: z.array(fileKindSchema).max(7).default(["pdf", "ebook"]),
  extensions: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9]{1,8}$/, "Use letters and digits, like srt")).max(20).default([]),
  /** What to look for, in your words, for your AI or Firecrawl's. */
  instruction: z.string().trim().max(2000).default(""),
  /** Who picks the links: Scaper's rules, your AI, or Firecrawl's AI (needs a Firecrawl key). */
  picker: z.enum(["rules", "ai", "firecrawl"]).default("rules"),
  mode: fetchModeSchema.default("fast"),
  /** Link hops from the start page to the file: 1 = the file is on a page the list links to. */
  depth: z.number().int().min(0).max(3).default(1),
  followNext: z.boolean().default(true),
  sameSite: z.boolean().default(true),
  maxPages: z.number().int().min(1).max(500).default(40),
  maxFiles: z.number().int().min(1).max(2000).default(200),
  /** Check links with no file ending (like /download?id=7) to see what they are. */
  probe: z.boolean().default(true),
  download: z.boolean().default(false),
  folder: z.string().trim().max(80).default(""),
});
export type FileFinderInput = z.infer<typeof fileFinderSchema>;

// The AI assistant on every page: one conversation, with the page you are on and what you selected.
export const assistantRequestSchema = z.object({
  prompt: z.string().trim().min(2, "Ask something").max(4000),
  followUpOf: z.string().max(40).optional(),
  model: z.enum(["main", "fast"]).default("main"),
  /** The page you are on, like /tasks/abc. */
  page: z.string().trim().max(300).default("/"),
  /** Rows you selected in a data table. */
  rows: z.object({
    source: z.string().trim().max(300).default(""),
    columns: z.array(z.string().max(200)).max(200).default([]),
    items: z.array(z.record(z.string(), z.unknown())).max(2000),
  }).optional(),
  /** One thing you asked about, like an alert or a change. */
  focus: z.object({ kind: z.string().max(40), id: z.string().max(80).optional(), title: z.string().max(300), body: z.string().max(2000).default(""), url: z.string().max(2048).nullable().optional() }).optional(),
});

export const botRunInputSchema = z.object({
  prompt: z.string().trim().max(8000).optional(),
  followUpOf: z.string().uuid().optional(),
});

// The visual browser.
export const browserInputSchema = z.object({
  events: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("mouse"), kind: z.enum(["move", "down", "up", "click", "dblclick"]), x: z.number(), y: z.number(), button: z.enum(["left", "right", "middle"]).default("left") }),
    z.object({ type: z.literal("wheel"), x: z.number(), y: z.number(), dx: z.number(), dy: z.number() }),
    z.object({ type: z.literal("key"), key: z.string().min(1).max(40), modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).default([]) }),
    z.object({ type: z.literal("text"), text: z.string().min(1).max(2000) }),
  ])).min(1).max(50),
});
export const browserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().trim().min(1).max(4000), tabId: z.string().max(40).optional() }),
  z.object({ action: z.enum(["back", "forward", "reload", "stop"]), tabId: z.string().max(40).optional() }),
  z.object({ action: z.literal("newTab"), url: z.string().trim().max(4000).optional() }),
  z.object({ action: z.enum(["closeTab", "switchTab"]), tabId: z.string().max(40) }),
  z.object({ action: z.literal("viewport"), width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) }),
  z.object({ action: z.literal("dialog"), accept: z.boolean(), text: z.string().max(2000).optional() }),
]);
export const browserSessionSchema = z.object({ action: z.enum(["open", "close"]), mode: z.enum(["normal", "incognito"]).default("normal") });
export const annotationInputSchema = z.object({
  x: z.number().min(0).max(100_000), y: z.number().min(0).max(1_000_000), w: z.number().min(2).max(10_000), h: z.number().min(2).max(10_000),
  note: z.string().trim().max(2000).default(""), color: z.enum(["amber", "red", "green", "blue", "violet"]).default("amber"),
});
export const bookmarkSchema = z.object({ url: z.string().trim().url().max(4000), title: z.string().trim().max(300).default("") });
export const browserAskSchema = z.object({ prompt: z.string().trim().min(1).max(8000), followUpOf: z.string().uuid().optional(), model: z.enum(["main", "fast"]).default("main") });
