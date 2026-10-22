import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { enqueue } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { createRecipe, validateCron } from "@/server/repo/scrapes";
import { getSettings } from "@/server/repo/settings";
import { aiColumnSchema, defaultTaskOptions, extractSchema, fetchModeSchema, paginationSchema, taskSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  name: z.string().trim().max(120).default(""),
  goal: z.string().trim().max(1000).default(""),
  startUrl: urlSchema,
  mode: fetchModeSchema,
  categories: z.array(z.object({ name: z.string().trim().min(1).max(120), url: urlSchema })).min(1, "Pick at least one category").max(200),
  extract: extractSchema,
  pagination: paginationSchema.default({ type: "none" }),
  maxPages: z.number().int().min(1).max(5000).default(60),
  maxRows: z.number().int().min(1).max(100_000).default(5000),
  aiFallback: z.boolean().default(true),
  aiColumns: z.array(aiColumnSchema).max(5).default([]),
  dedupeBy: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  private: z.boolean().optional(),
  // Save as a task (optionally on a schedule) instead of a one-off run.
  save: z.object({ scheduleMinutes: z.number().int().min(15).max(10080).nullable().default(null), cron: z.string().trim().max(120).nullable().default(null) }).optional(),
});

/** Category scrape, step 2: run the plan now (as a job) or save it as a task. */
export const POST = handler(async (req) => {
  rateLimit("crawl:run", 10, 4);
  const input = await readJson(req, schema);
  const host = new URL(input.startUrl).hostname.replace(/^www\./, "");
  const options = {
    ...defaultTaskOptions(),
    categories: input.categories,
    pagination: input.pagination,
    limits: { maxPages: input.maxPages, maxRows: input.maxRows },
    aiFallback: input.aiFallback,
    aiColumns: input.aiColumns,
    dedupeBy: input.dedupeBy,
    includeSourceUrl: true,
  };
  const name = input.name || `Categories on ${host}`;
  if (input.save) {
    validateCron(input.save.cron);
    const task = createRecipe(taskSchema.parse({
      name, description: input.goal ? `Category scrape: ${input.goal}` : "Category scrape", url: input.startUrl, mode: input.mode,
      extract: input.extract, options, tags: ["categories"], scheduleMinutes: input.save.scheduleMinutes, cron: input.save.cron,
    }));
    audit("task.created", { taskId: task.id, from: "category_scrape", categories: input.categories.length });
    const job = enqueue({ kind: "task", refId: task.id, title: `Task: ${task.name}`, trigger: "manual", input: { taskId: task.id }, priority: 10, unique: true });
    return { job, taskId: task.id };
  }
  const priv = input.private ?? getSettings().data.privateMode;
  const job = enqueue({
    kind: "scrape", title: priv ? "Private category scrape" : `Category scrape: ${host} (${input.categories.length})`, trigger: "manual", priority: 10, private: priv,
    input: { url: input.startUrl, mode: input.mode, extract: input.extract, options },
  });
  return { job, taskId: null };
});
