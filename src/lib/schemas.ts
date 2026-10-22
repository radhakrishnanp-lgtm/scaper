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

export const fetchModeSchema = z.enum(["browser", "fast"]);
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
    useFastModel: z.boolean().default(true),
  }),
]);
export type ExtractSpec = z.infer<typeof extractSchema>;

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
});
export type NotifyChannels = z.infer<typeof notifySchema>;
export const NOTIFY_CHANNELS = ["desktop", "webhook", "telegram", "discord", "slack", "ntfy", "email"] as const;

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
    channels: notifySchema.default({ desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false }),
  }).default({ enabled: false, keyFields: [], notifyNew: true, notifyRemoved: false, channels: { desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false } }),
  output: z.object({
    files: z.array(z.enum(["csv", "json", "xlsx", "ndjson"])).max(4).default([]),
    webhook: z.boolean().default(false),
  }).default({ files: [], webhook: false }),
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
  /** Continue the conversation of an earlier run. */
  followUpOf: z.string().max(40).optional(),
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

export const aiSettingsSchema = z.object({
  baseUrl: z.string().trim().max(500).default(""),
  apiKey: z.string().trim().max(500).default(""),
  model: z.string().trim().max(200).default(""),
  fastModel: z.string().trim().max(200).default(""),
  dailyRequestLimit: z.number().int().min(1).max(100000).default(300),
  maxTokens: z.number().int().min(64).max(32000).default(1500),
  agentMaxSteps: z.number().int().min(1).max(25).default(8),
});

export const scrapingSettingsSchema = z.object({
  userAgent: z.string().trim().max(400).default(""),
  minDelaySeconds: z.number().min(1).max(600).default(5),
  respectRobots: z.boolean().default(true),
  proxyUrl: z.string().trim().max(500).default(""),
  maxConcurrency: z.number().int().min(1).max(4).default(2),
  jobConcurrency: z.number().int().min(1).max(8).default(3),
  blockHeavyResources: z.boolean().default(true),
  allowPrivateNetwork: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(5).max(120).default(30),
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

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
  quietHoursEnabled: z.boolean().default(false),
  quietStart: clock.default("22:00"),
  quietEnd: clock.default("07:00"),
  failureAlertAfter: z.number().int().min(1).max(50).default(3),
  errorAlertCooldownMinutes: z.number().int().min(0).max(10080).default(360),
  // Pause every external channel at once (alerts still reach the inbox).
  muteAll: z.boolean().default(false),
  // Once a day, one message with everything that changed.
  digest: z.enum(["off", "daily"]).default("off"),
  digestHour: z.number().int().min(0).max(23).default(8),
});

export const dataSettingsSchema = z.object({
  keepRuns: z.number().int().min(20).max(100_000).default(1000),
  keepSnapshots: z.number().int().min(10).max(10_000).default(300),
  keepJobsDays: z.number().int().min(1).max(365).default(30),
  keepEventsDays: z.number().int().min(1).max(365).default(30),
  autoBackup: z.boolean().default(true),
  keepBackups: z.number().int().min(1).max(60).default(7),
});

export const settingsSchema = z.object({
  ai: aiSettingsSchema,
  scraping: scrapingSettingsSchema,
  notifications: notificationSettingsSchema,
  data: dataSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = z.object({
  ai: aiSettingsSchema.partial().optional(),
  scraping: scrapingSettingsSchema.partial().optional(),
  notifications: notificationSettingsSchema.partial().optional(),
  data: dataSettingsSchema.partial().optional(),
});

export const apiTokenSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(80) });

export const loginSchema = z.object({ password: z.string().min(1).max(500) });
