import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { fetchPage } from "@/server/fetcher";
import { pageFor } from "@/server/fetcher/page-cache";
import { extractWithSelectors, testSelector } from "@/server/extract/selectors";
import { extractSchema, fetchModeSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  url: urlSchema,
  mode: fetchModeSchema.default("browser"),
  selector: z.string().trim().max(500).optional(),
  attr: z.string().trim().max(60).default("text"),
  extract: extractSchema.optional(),
});

/**
 * Selector lab: live match count and sample values for a selector, or a preview of a whole
 * selector setup. Reuses the page from the picker when it was opened recently, so typing doesn't reload the site.
 */
export const POST = handler(async (req) => {
  rateLimit("inspect:test", 120, 30);
  const input = await readJson(req, schema);
  // Browser-rendered and plain-HTTP versions of a page can differ, so they are cached separately.
  const page = await pageFor(input.mode === "browser" ? input.url : `fast:${input.url}`, () => {
    rateLimit("inspect:fetch", 10, 3);
    return fetchPage(input.url, input.mode);
  });
  try {
    if (input.extract?.type === "selectors") {
      const ds = extractWithSelectors(page.html, page.url, input.extract);
      return { count: ds.rows.length, columns: ds.columns, rows: ds.rows.slice(0, 10), cached: true };
    }
    if (!input.selector) throw new HttpError(400, "validation", "Enter a selector.");
    return { ...testSelector(page.html, page.url, input.selector, input.attr), cached: true };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "bad_selector", (e as Error).message);
  }
});
