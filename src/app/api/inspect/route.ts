import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { fetchPage } from "@/server/fetcher";
import { rememberPage } from "@/server/fetcher/page-cache";
import { browserStepSchema, urlSchema } from "@/lib/schemas";

/** Element picker: renders the page once and returns a screenshot plus clickable element boxes. */
export const POST = handler(async (req) => {
  rateLimit("inspect", 10, 3);
  const { url, steps } = await readJson(req, z.object({ url: urlSchema, steps: z.array(browserStepSchema).max(30).default([]) }));
  const page = await fetchPage(url, "browser", { inspect: true, steps });
  if (!page.inspect || !page.screenshot) throw new HttpError(502, "inspect_failed", "Could not capture the page.");
  rememberPage([url, page.finalUrl], page.html, page.finalUrl);
  return { url: page.finalUrl, title: page.title, screenshot: page.screenshot, ...page.inspect };
});
