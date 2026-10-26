import { handler, rateLimit, readJson } from "@/server/api";
import { enqueue } from "@/server/jobs";
import { listJobs } from "@/server/repo/jobs";
import { getSettings } from "@/server/repo/settings";
import { fileFinderSchema } from "@/lib/schemas";
import { resolveModel } from "@/server/ai/client";
import { firecrawlReady } from "@/server/integrations/firecrawl";

export const dynamic = "force-dynamic";

/** Recent file searches, newest first (results are in each job's `result`). */
export const GET = handler(async () => ({
  jobs: listJobs({ kind: "files", limit: 20 }),
  ready: { ai: Boolean(resolveModel("fast")), firecrawl: firecrawlReady() },
}));

/** Starts a file search: walks the pages and returns the files found; with `download` they go to Downloads too. */
export const POST = handler(async (req) => {
  rateLimit("files:find", 20, 10);
  const input = await readJson(req, fileFinderSchema);
  let host = "";
  try { host = new URL(input.urls[0]!).hostname; } catch { /* validated already */ }
  const job = enqueue({
    kind: "files", title: `Find files on ${host}${input.urls.length > 1 ? ` and ${input.urls.length - 1} more` : ""}`,
    trigger: req.headers.get("authorization") ? "api" : "manual", input: input as unknown as Record<string, unknown>,
    private: getSettings().data.privateMode,
  });
  return { job };
});
