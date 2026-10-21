import { handler, rateLimit, readJson } from "@/server/api";
import { runScrape } from "@/server/scrape";
import { scrapeRequestSchema } from "@/lib/schemas";

export const POST = handler(async (req) => {
  rateLimit("scrape", 30, 10);
  const input = await readJson(req, scrapeRequestSchema);
  return { run: await runScrape(input) };
});
