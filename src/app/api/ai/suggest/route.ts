import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { suggestSelectors } from "@/server/ai/suggest";
import { fetchPage } from "@/server/fetcher";
import { pageFor } from "@/server/fetcher/page-cache";
import { fetchModeSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  url: urlSchema,
  describe: z.string().trim().min(3, "Describe the data you want").max(500),
  mode: fetchModeSchema.default("browser"),
  useFastModel: z.boolean().default(true),
});

/** "Build with AI": proposes an item selector and fields from a plain description, tested on the page. */
export const POST = handler(async (req) => {
  rateLimit("ai:suggest", 20, 5);
  const input = await readJson(req, schema);
  // Browser-rendered and plain-HTTP versions of a page can differ, so they are cached separately.
  const page = await pageFor(input.mode === "browser" ? input.url : `fast:${input.url}`, () => {
    rateLimit("inspect:fetch", 10, 3);
    return fetchPage(input.url, input.mode);
  });
  return suggestSelectors(page.html, page.url, input.describe, input.useFastModel ? "fast" : "main");
});
