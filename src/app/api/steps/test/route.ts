import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { fetchPage, FetchError } from "@/server/fetcher";
import { browserStepSchema, urlSchema } from "@/lib/schemas";

/** Runs page actions in the browser and shows how far they got, with a screenshot of the result. */
export const POST = handler(async (req) => {
  rateLimit("steps:test", 8, 3);
  const { url, steps } = await readJson(req, z.object({ url: urlSchema, steps: z.array(browserStepSchema).min(1).max(30) }));
  try {
    const page = await fetchPage(url, "browser", { steps, screenshot: true });
    return { ok: true, log: page.notes, screenshot: page.screenshot ?? null, finalUrl: page.finalUrl, title: page.title };
  } catch (e) {
    if (e instanceof FetchError && e.code === "step") return { ok: false, log: [e.message], screenshot: null, error: e.message };
    throw e;
  }
});
