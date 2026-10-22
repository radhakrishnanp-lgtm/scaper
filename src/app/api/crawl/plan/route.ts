import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { planCategoryScrape } from "@/server/ai/crawl";
import { withWork } from "@/server/privacy";
import { getSettings } from "@/server/repo/settings";
import { fetchModeSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  url: urlSchema,
  goal: z.string().trim().min(3, "Say what you want from this site").max(1000),
  mode: fetchModeSchema.default("browser"),
  maxCategories: z.number().int().min(1).max(50).default(8),
  pagesPerCategory: z.number().int().min(1).max(100).default(3),
  useFastModel: z.boolean().default(false),
  private: z.boolean().optional(),
});

/** Category scrape, step 1: your AI picks the category pages and Scaper works out the item layout. Nothing is saved. */
export const POST = handler(async (req) => {
  rateLimit("crawl:plan", 6, 3);
  const input = await readJson(req, schema);
  const priv = input.private ?? getSettings().data.privateMode;
  const plan = await withWork({ private: priv, purpose: "plan" }, () =>
    planCategoryScrape({ ...input, model: input.useFastModel ? "fast" : "main", signal: req.signal }));
  return { plan };
});
