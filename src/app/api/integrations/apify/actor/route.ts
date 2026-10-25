import { handler, HttpError, rateLimit } from "@/server/api";
import { apifyActor } from "@/server/integrations/apify";
import { IntegrationError } from "@/server/integrations/firecrawl";
import { apifyActorIdSchema } from "@/lib/schemas";

/** One actor's title and example input: `?id=apify~instagram-scraper`. */
export const GET = handler(async (req) => {
  rateLimit("apify:actor", 20, 5);
  const parsed = apifyActorIdSchema.safeParse(req.nextUrl.searchParams.get("id") ?? "");
  if (!parsed.success) throw new HttpError(400, "invalid", "Use the actor id, like apify~instagram-scraper.");
  try { return await apifyActor(parsed.data); }
  catch (e) { if (e instanceof IntegrationError) throw new HttpError(502, "apify", e.message); throw e; }
});
