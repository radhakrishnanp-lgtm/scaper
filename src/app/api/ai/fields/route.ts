import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { suggestFields } from "@/server/ai/extract";
import { fetchPage } from "@/server/fetcher";
import { pageFor } from "@/server/fetcher/page-cache";
import { fetchModeSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  url: urlSchema,
  describe: z.string().trim().max(500).default(""),
  mode: fetchModeSchema.default("browser"),
  useFastModel: z.boolean().default(true),
});

/** "Suggest fields": your model looks at the page and proposes the columns to extract. */
export const POST = handler(async (req) => {
  rateLimit("ai:fields", 20, 5);
  const input = await readJson(req, schema);
  const page = await pageFor(input.mode === "browser" ? input.url : `fast:${input.url}`, () => {
    rateLimit("inspect:fetch", 10, 3);
    return fetchPage(input.url, input.mode);
  });
  return suggestFields(page.html, page.url, input.describe, input.useFastModel ? "fast" : "main");
});
