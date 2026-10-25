import { handler, HttpError, rateLimit } from "@/server/api";
import { apifyStore } from "@/server/integrations/apify";
import { IntegrationError } from "@/server/integrations/firecrawl";

/** Search the Apify Store for actors: `?q=instagram`. */
export const GET = handler(async (req) => {
  rateLimit("apify:store", 20, 5);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) throw new HttpError(400, "invalid", "Type what you want to scrape, like instagram or youtube.");
  try { return { actors: await apifyStore(q, 12) }; }
  catch (e) { if (e instanceof IntegrationError) throw new HttpError(502, "apify", e.message); throw e; }
});
