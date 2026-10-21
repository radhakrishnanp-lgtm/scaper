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
});
export type Field = z.infer<typeof fieldSchema>;

export const extractSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }),
  z.object({
    type: z.literal("selectors"),
    itemSelector: z.string().trim().max(500).optional().default(""),
    fields: z.array(fieldSchema).min(1, "Add at least one field").max(30),
  }),
  z.object({
    type: z.literal("ai"),
    instruction: z.string().trim().min(3, "Describe what to extract").max(2000),
    useFastModel: z.boolean().default(true),
  }),
]);
export type ExtractSpec = z.infer<typeof extractSchema>;

export const scrapeRequestSchema = z.object({
  url: urlSchema,
  mode: fetchModeSchema.default("browser"),
  extract: extractSchema,
  screenshot: z.boolean().default(false),
  recipeId: z.string().uuid().optional(),
});

export const recipeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  url: urlSchema,
  mode: fetchModeSchema,
  extract: extractSchema,
  // Run automatically and save a CSV each time. null = manual only.
  scheduleMinutes: z.number().int().min(15).max(10080).nullable().default(null),
});

export const watchTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page") }),
  z.object({ type: z.literal("selector"), selector }),
  z.object({ type: z.literal("price"), selector: z.string().trim().max(500).optional().default("") }),
]);
export type WatchTarget = z.infer<typeof watchTargetSchema>;

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("any_change") }),
  z.object({ type: z.literal("contains"), text: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("not_contains"), text: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("below"), value: z.number().nonnegative() }),
  z.object({ type: z.literal("above"), value: z.number().nonnegative() }),
  z.object({ type: z.literal("drop_percent"), percent: z.number().min(0.1).max(100) }),
  z.object({ type: z.literal("ai"), question: z.string().trim().min(5).max(1000) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const notifySchema = z.object({
  desktop: z.boolean().default(true),
  webhook: z.boolean().default(false),
  telegram: z.boolean().default(false),
});
export type NotifyChannels = z.infer<typeof notifySchema>;

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
});
export type WatcherInput = z.infer<typeof watcherSchema>;

export const productInputSchema = z.object({
  url: urlSchema,
  targetPrice: z.number().positive().nullable().optional(),
  intervalMinutes: z.number().int().min(15).max(10080).default(360),
});

export const dealScanSchema = z.object({
  url: urlSchema,
  minDiscount: z.number().min(0).max(95).default(0),
  rankWithAi: z.boolean().default(false),
});

export const agentRequestSchema = z.object({
  prompt: z.string().trim().min(3, "Tell the agent what to do").max(4000),
  useFastModel: z.boolean().default(false),
});

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
  blockHeavyResources: z.boolean().default(true),
  allowPrivateNetwork: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(5).max(120).default(30),
});

export const notificationSettingsSchema = z.object({
  webhookUrl: z.string().trim().max(1000).default(""),
  telegramBotToken: z.string().trim().max(200).default(""),
  telegramChatId: z.string().trim().max(100).default(""),
});

export const settingsSchema = z.object({
  ai: aiSettingsSchema,
  scraping: scrapingSettingsSchema,
  notifications: notificationSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = z.object({
  ai: aiSettingsSchema.partial().optional(),
  scraping: scrapingSettingsSchema.partial().optional(),
  notifications: notificationSettingsSchema.partial().optional(),
});

export const loginSchema = z.object({ password: z.string().min(1).max(500) });
