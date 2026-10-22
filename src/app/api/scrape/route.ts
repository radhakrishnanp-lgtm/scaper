import { handler, rateLimit, readJson } from "@/server/api";
import { enqueueAndWait } from "@/server/jobs";
import { getRun } from "@/server/repo/scrapes";
import { scrapeRequestSchema } from "@/lib/schemas";

/** Quick scrape: runs as a job (so it shows on the Runs page and respects concurrency) and waits for the result. */
export const POST = handler(async (req) => {
  rateLimit("scrape", 30, 10);
  const input = await readJson(req, scrapeRequestSchema);
  const multi = Boolean(input.options && (input.options.startUrls.length || input.options.pagination.type !== "none" || input.options.crawl.enabled || input.options.detail.enabled || input.options.sitemap.url || input.options.inputs));
  const job = await enqueueAndWait({
    kind: "scrape", title: `Scrape: ${new URL(input.url).hostname}${multi ? " (multi-page)" : ""}`, refId: input.recipeId ?? null,
    trigger: req.headers.get("authorization") ? "api" : "manual", input: input as unknown as Record<string, unknown>,
  }, 100_000);
  const runId = job.result?.runId as string | undefined;
  return { job, run: runId ? getRun(runId) : null };
});
