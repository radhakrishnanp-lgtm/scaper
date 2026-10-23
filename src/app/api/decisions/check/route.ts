import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { checkScrape } from "@/server/ai/judge";
import { withWork } from "@/server/privacy";
import { audit } from "@/server/repo/events";
import { getSettings } from "@/server/repo/settings";
import { fetchModeSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  url: urlSchema,
  goal: z.string().trim().max(300).optional(),
  mode: fetchModeSchema.default("fast"),
  private: z.boolean().optional(),
});

/** "Is this OK to scrape?": robots.txt and page rules first, then the decision model's read of the page. */
export const POST = handler(async (req) => {
  rateLimit("decisions:check", 12, 4);
  const input = await readJson(req, schema);
  const priv = input.private ?? getSettings().data.privateMode;
  const check = await withWork({ private: priv, purpose: "scrape-check" }, () => checkScrape({ ...input, signal: req.signal }));
  if (!priv) audit("decisions.scrape_check", { host: new URL(input.url).hostname, outcome: check.outcome });
  return { check };
});
